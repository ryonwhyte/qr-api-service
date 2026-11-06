/**
 * Prove the service renders real, scannable QR codes.
 *
 * The outage on 6 November 2026 was invisible for hours because /health returned a
 * static {"status":"ok"} and nothing ever checked that a PNG came back, let alone that
 * it decoded. So this does both: it asks for the exact shapes Cardyfi asks for, checks
 * the bytes really are the format claimed, and decodes the PNGs back to the input.
 *
 *   npm install          (devDependencies include the decoder)
 *   npm run smoke        against http://localhost:3000
 *   BASE=https://qr-api.cardyfi.com npm run smoke
 */

const { PNG } = require('pngjs');
const jsQRModule = require('jsqr');

const jsQR = jsQRModule.default || jsQRModule;
const BASE = process.env.BASE || 'http://localhost:3000';

const PNG_SIGNATURE = '89504e470d0a1a0a';
const JPEG_SIGNATURE = 'ffd8ff';

let passed = 0;
const failures = [];

function ok(condition, label, detail) {
  if (condition) {
    passed++;
    console.log(`  ok     ${label}${detail ? `  (${detail})` : ''}`);
  } else {
    failures.push(label);
    console.log(`  FAIL   ${label}${detail ? `  (${detail})` : ''}`);
  }
}

function decodePng(buffer) {
  const png = PNG.sync.read(buffer);
  const result = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  return { width: png.width, height: png.height, data: result ? result.data : null };
}

async function get(pathAndQuery) {
  const response = await fetch(BASE + pathAndQuery);
  const buffer = Buffer.from(await response.arrayBuffer());
  return { status: response.status, type: response.headers.get('content-type') || '', buffer };
}

/** The merchant payment code, exactly as the WordPress plugin requests it. */
function merchantQuery(data, format) {
  const params = new URLSearchParams({
    data,
    width: '400',
    height: '400',
    backgroundColor: '#ffffff',
    dotsColor: '#000000',
    cornersSquareColor: '#ff0000',
    cornersDotColor: '#4b0f95',
    borderRadius: '20',
    margin: '0',
    imageMargin: '4',
    dotsType: 'dots',
    cornersSquareType: 'dot',
    cornersDotType: 'dot',
    errorCorrectionLevel: 'H',
  });
  if (format) params.set('format', format);
  return '/generate?' + params.toString();
}

(async () => {
  console.log(`Testing ${BASE}\n`);

  console.log('A real PNG comes back, and it scans');
  const payload = 'https://go.cardyfi.com/cpaym/LV3XER';
  const png = await get(merchantQuery(payload));
  ok(png.status === 200, 'HTTP 200', `got ${png.status}`);
  ok(png.type.startsWith('image/png'), 'Content-Type is image/png', png.type);
  ok(
    png.buffer.subarray(0, 8).toString('hex') === PNG_SIGNATURE,
    'body really is a PNG',
    `${png.buffer.length} bytes`
  );

  if (png.status === 200 && png.buffer.subarray(0, 8).toString('hex') === PNG_SIGNATURE) {
    const decoded = decodePng(png.buffer);
    ok(decoded.width === 400 && decoded.height === 400, 'rendered at the size asked for', `${decoded.width}x${decoded.height}`);
    ok(decoded.data === payload, 'decodes back to the data sent', decoded.data || 'did not decode');
  }

  console.log('\nThe other formats still work');
  const jpeg = await get(merchantQuery(payload, 'jpeg'));
  ok(jpeg.status === 200 && jpeg.buffer.subarray(0, 3).toString('hex') === JPEG_SIGNATURE, 'jpeg is a JPEG', `${jpeg.buffer.length} bytes`);

  const svg = await get(merchantQuery(payload, 'svg'));
  ok(svg.status === 200 && svg.buffer.toString('utf8', 0, 200).includes('<svg'), 'svg is an SVG', `${svg.buffer.length} bytes`);

  console.log('\nThe gift card code, which is a long encrypted payload');
  const cardPayload = 'encv1:74037b7d13666057050a0f1a100a2a3731643428600307576841401b14032a50710d723219626059';
  const card = await get(`/generate?data=${encodeURIComponent(cardPayload)}&width=300&height=300&errorCorrectionLevel=H&dotsType=dots`);
  ok(card.status === 200 && card.buffer.subarray(0, 8).toString('hex') === PNG_SIGNATURE, 'gift card PNG renders', `${card.buffer.length} bytes`);
  if (card.status === 200 && card.buffer.subarray(0, 8).toString('hex') === PNG_SIGNATURE) {
    ok(decodePng(card.buffer).data === cardPayload, 'gift card payload survives the round trip');
  }

  console.log('\nConcurrency: the old shared download directory could serve one caller another caller\'s QR');
  const tokens = ['AAA111', 'BBB222', 'CCC333', 'DDD444', 'EEE555', 'FFF666', 'GGG777', 'HHH888'];
  const results = await Promise.all(
    tokens.map((t) => get(merchantQuery(`https://go.cardyfi.com/cpaym/${t}`)))
  );
  const decodedAll = results.map((r, i) =>
    r.status === 200 && r.buffer.subarray(0, 8).toString('hex') === PNG_SIGNATURE
      ? decodePng(r.buffer).data
      : `HTTP ${r.status}`
  );
  const expected = tokens.map((t) => `https://go.cardyfi.com/cpaym/${t}`);
  const mismatches = decodedAll.filter((d, i) => d !== expected[i]);
  ok(mismatches.length === 0, `${tokens.length} concurrent requests each got their OWN code`, mismatches.length ? `${mismatches.length} wrong: ${mismatches.join(', ')}` : 'no crossover');

  console.log('\nHealth check actually renders');
  const health = await get('/health');
  let healthBody = {};
  try { healthBody = JSON.parse(health.buffer.toString('utf8')); } catch { /* not JSON */ }
  ok(health.status === 200 && healthBody.render === 'ok', 'health reports a successful render', JSON.stringify(healthBody));

  console.log('\nBad input is refused rather than guessed at');
  const noData = await get('/generate?data=');
  ok(noData.status === 400, 'missing data returns 400', `got ${noData.status}`);

  console.log('');
  console.log(`${passed} checks passed${failures.length ? `, ${failures.length} FAILURES:` : ', everything renders and scans.'}`);
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.error('\nSmoke test could not run: ' + e.message);
  process.exit(1);
});
