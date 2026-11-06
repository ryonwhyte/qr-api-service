/**
 * QR Code API.
 *
 * Renders QR codes with qr-code-styling inside a page this service controls.
 *
 * It used to drive the Mini QR web app in a headless browser: set its form fields by
 * element id, click its download button, wait two seconds, then look in a shared
 * directory for a file with the right extension. That failed in three ways, and all
 * three are gone now rather than patched.
 *
 *   1. mini-qr was pinned to :latest, so its UI could change on any pull. On
 *      6 November 2026 its PNG export stopped producing a browser download and every
 *      PNG request began returning "Download failed - no file found". SVG and JPEG
 *      kept working, which is why /health looked fine. Nothing had changed here.
 *
 *   2. Every request downloaded into one shared directory and took the first file
 *      matching the extension. Concurrent requests raced: the loser reported no file,
 *      and a request could be handed ANOTHER request's QR code. For a gift card that
 *      is an encrypted redemption payload for the wrong card. That is the likeliest
 *      explanation for the interleaved successes and failures on 1 November.
 *
 *   3. The two-second sleep was not a wait. Chromium writes partial downloads as
 *      .crdownload, which never matches .png, so a slow render read as a failure.
 *
 * Now the QR is rendered in a blank page with the library loaded from node_modules,
 * and the bytes are read straight out of it. No mini-qr, no element ids, no browser
 * downloads, no shared filesystem, and nothing for two requests to collide over.
 */

const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3000;

// The UMD build, loaded into the page. Resolved through require so it follows the
// installed package rather than a hand-written path that npm layout changes can break.
const QR_LIB_PATH = path.join(
  path.dirname(require.resolve('qr-code-styling/package.json')),
  'lib/qr-code-styling.js'
);

const RENDER_TIMEOUT_MS = 20000;
const LOGO_TIMEOUT_MS = 10000;
const LOGO_MAX_BYTES = 2 * 1024 * 1024;
const MAX_DIMENSION = 2000;
const MAX_DATA_LENGTH = 4296; // The most a QR code can hold (alphanumeric, level L).

const DOT_TYPES = ['dots', 'rounded', 'classy', 'classy-rounded', 'square', 'extra-rounded'];
const CORNER_SQUARE_TYPES = ['dot', 'square', 'extra-rounded'];
const CORNER_DOT_TYPES = ['dot', 'square'];
const ERROR_CORRECTION_LEVELS = ['L', 'M', 'Q', 'H'];
const FORMATS = ['png', 'jpeg', 'svg'];

let browser = null;
let browserPromise = null;

/**
 * The shared browser, relaunched if it died.
 *
 * The old version cached the instance for ever. If Chromium crashed, every later
 * request failed until someone restarted the container, while /health kept saying ok.
 */
async function getBrowser() {
  if (browser && browser.connected) {
    return browser;
  }
  if (!browserPromise) {
    browserPromise = puppeteer
      .launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
        ],
      })
      .then((b) => {
        browser = b;
        b.on('disconnected', () => {
          browser = null;
          browserPromise = null;
        });
        return b;
      })
      .catch((err) => {
        browserPromise = null;
        throw err;
      });
  }
  return browserPromise;
}

function clampInt(value, fallback, min, max) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/** A hex colour, or the fallback. Keeps caller input out of the page unchecked. */
function safeColor(value, fallback) {
  return typeof value === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(value) ? value : fallback;
}

function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

/**
 * Fetch the logo here and inline it as a data URI.
 *
 * Letting the page load it by URL taints the canvas unless the logo host sends CORS
 * headers, and a tainted canvas makes the export throw. Inlining sidesteps that, keeps
 * the browser off the network, and lets us bound the time and size.
 */
async function fetchLogoAsDataUri(logoUrl) {
  let parsed;
  try {
    parsed = new URL(logoUrl);
  } catch {
    throw new Error('logoUrl is not a valid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('logoUrl must be http or https');
  }

  const response = await fetch(parsed.toString(), {
    signal: AbortSignal.timeout(LOGO_TIMEOUT_MS),
    redirect: 'follow',
  });
  if (!response.ok) {
    throw new Error(`logo fetch returned HTTP ${response.status}`);
  }

  const contentType = (response.headers.get('content-type') || '').split(';')[0].trim();
  if (!contentType.startsWith('image/')) {
    throw new Error(`logo is not an image (${contentType || 'no content-type'})`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > LOGO_MAX_BYTES) {
    throw new Error('logo is larger than 2MB');
  }

  return `data:${contentType};base64,${buffer.toString('base64')}`;
}

/** Map the public API onto qr-code-styling's option shape. */
function buildQrOptions(options) {
  const {
    data,
    backgroundColor,
    dotsColor,
    cornersSquareColor,
    cornersDotColor,
    width,
    height,
    margin,
    imageMargin,
    dotsType,
    cornersSquareType,
    cornersDotType,
    errorCorrectionLevel,
  } = options;

  const qr = {
    width: clampInt(width, 300, 32, MAX_DIMENSION),
    height: clampInt(height, 300, 32, MAX_DIMENSION),
    data: String(data),
    margin: clampInt(margin, 10, 0, 200),
    qrOptions: {
      errorCorrectionLevel: oneOf(errorCorrectionLevel, ERROR_CORRECTION_LEVELS, 'M'),
    },
    imageOptions: {
      margin: clampInt(imageMargin, 0, 0, 100),
      crossOrigin: 'anonymous',
    },
    dotsOptions: {
      color: safeColor(dotsColor, '#000000'),
      type: oneOf(dotsType, DOT_TYPES, 'square'),
    },
    backgroundOptions: {
      color: safeColor(backgroundColor, '#ffffff'),
    },
  };

  // Left unset, qr-code-styling falls back to the dots colour, which is what the
  // caller omitting them means.
  if (cornersSquareColor || cornersSquareType) {
    qr.cornersSquareOptions = {
      color: safeColor(cornersSquareColor, qr.dotsOptions.color),
      type: oneOf(cornersSquareType, CORNER_SQUARE_TYPES, 'square'),
    };
  }
  if (cornersDotColor || cornersDotType) {
    qr.cornersDotOptions = {
      color: safeColor(cornersDotColor, qr.dotsOptions.color),
      type: oneOf(cornersDotType, CORNER_DOT_TYPES, 'square'),
    };
  }

  return qr;
}

async function generateQRCode(options) {
  const { data, logoUrl, format: rawFormat } = options;

  if (!data || String(data).trim() === '') {
    const err = new Error('Data to encode is required');
    err.statusCode = 400;
    throw err;
  }
  if (String(data).length > MAX_DATA_LENGTH) {
    const err = new Error(`Data is too long for a QR code (max ${MAX_DATA_LENGTH} characters)`);
    err.statusCode = 400;
    throw err;
  }

  const format = oneOf(rawFormat, FORMATS, 'png');
  const qrOptions = buildQrOptions(options);

  if (logoUrl) {
    try {
      qrOptions.image = await fetchLogoAsDataUri(logoUrl);
    } catch (e) {
      const err = new Error(`Could not load logoUrl: ${e.message}`);
      err.statusCode = 400;
      throw err;
    }
  }

  const browserInstance = await getBrowser();
  const page = await browserInstance.newPage();

  try {
    page.setDefaultTimeout(RENDER_TIMEOUT_MS);

    // A blank local page. Nothing is fetched over the network, so there is no
    // third-party UI to break and nothing to wait on.
    await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body><div id="qr"></div></body></html>');
    await page.addScriptTag({ path: QR_LIB_PATH });

    const result = await page.evaluate(
      async (opts, fmt) => {
        const QRCodeStyling = window.QRCodeStyling;
        if (typeof QRCodeStyling !== 'function') {
          return { error: 'qr-code-styling did not load in the page' };
        }

        // SVG output needs an SVG renderer; raster formats come off a canvas.
        const qr = new QRCodeStyling({ ...opts, type: fmt === 'svg' ? 'svg' : 'canvas' });
        qr.append(document.getElementById('qr'));

        let blob;
        try {
          blob = await qr.getRawData(fmt);
        } catch (e) {
          return { error: 'render failed: ' + (e && e.message ? e.message : String(e)) };
        }
        if (!blob) {
          return { error: 'render produced no data' };
        }

        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = '';
        const CHUNK = 0x8000; // Avoid blowing the argument limit on apply().
        for (let i = 0; i < bytes.length; i += CHUNK) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        }
        return { base64: btoa(binary) };
      },
      qrOptions,
      format
    );

    if (result.error) {
      throw new Error(result.error);
    }

    const buffer = Buffer.from(result.base64, 'base64');

    // The old code could return a JSON error body or a partial file as if it were an
    // image, and callers wrote it to disk as a .png. Check before answering.
    if (format === 'png' && buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
      throw new Error('rendered output is not a valid PNG');
    }
    if (buffer.length === 0) {
      throw new Error('rendered output was empty');
    }

    return { buffer, format };
  } finally {
    await page.close().catch(() => {});
  }
}

function contentTypeFor(format) {
  return format === 'svg' ? 'image/svg+xml' : `image/${format}`;
}

function readQueryOptions(query) {
  return {
    data: query.data,
    logoUrl: query.logoUrl,
    backgroundColor: query.backgroundColor,
    dotsColor: query.dotsColor,
    cornersSquareColor: query.cornersSquareColor,
    cornersDotColor: query.cornersDotColor,
    width: query.width,
    height: query.height,
    margin: query.margin,
    imageMargin: query.imageMargin,
    dotsType: query.dotsType,
    cornersSquareType: query.cornersSquareType,
    cornersDotType: query.cornersDotType,
    errorCorrectionLevel: query.errorCorrectionLevel,
    format: query.format,
    // borderRadius is accepted and ignored. It styled the Mini QR preview container
    // and never changed the exported image, so honouring it now would alter how every
    // existing QR code looks.
  };
}

async function respondWithQr(res, options) {
  const { buffer, format } = await generateQRCode(options);
  res.set('Content-Type', contentTypeFor(format));
  res.set('Content-Length', String(buffer.length));
  res.set('Cache-Control', 'no-store');
  res.send(buffer);
}

function sendError(res, error) {
  const status = error.statusCode || 500;
  if (status >= 500) {
    console.error('Error generating QR code:', error);
  }
  res.status(status).json({ error: error.message });
}

/**
 * Health check that actually renders.
 *
 * The old one returned a static object, so both outages ran silently behind a green
 * check. This generates a real QR, which is the only thing worth knowing.
 */
app.get('/health', async (req, res) => {
  try {
    const { buffer } = await generateQRCode({ data: 'health', width: 64, height: 64 });
    res.json({ status: 'ok', service: 'qr-api', render: 'ok', bytes: buffer.length });
  } catch (error) {
    console.error('Health check failed:', error);
    res.status(503).json({ status: 'error', service: 'qr-api', render: 'failed', error: error.message });
  }
});

app.post('/generate', async (req, res) => {
  try {
    await respondWithQr(res, req.body || {});
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/generate', async (req, res) => {
  try {
    await respondWithQr(res, readQueryOptions(req.query));
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/', (req, res) => {
  res.json({
    name: 'QR Code API',
    version: '2.0.0',
    endpoints: {
      'GET /health': 'Health check (renders a real QR code)',
      'POST /generate': 'Generate QR code with full options',
      'GET /generate': 'Generate QR code with query parameters',
    },
    options: {
      data: 'Required. The data to encode in the QR code',
      logoUrl: 'Optional. URL of logo image to embed',
      backgroundColor: 'Optional. Background color (hex). Default: #ffffff',
      dotsColor: 'Optional. Dots color (hex). Default: #000000',
      cornersSquareColor: 'Optional. Corners square color (hex)',
      cornersDotColor: 'Optional. Corners dot color (hex)',
      width: 'Optional. QR code width in pixels. Default: 300',
      height: 'Optional. QR code height in pixels. Default: 300',
      borderRadius: 'Accepted and ignored. It never affected the exported image.',
      margin: 'Optional. Margin in pixels. Default: 10',
      imageMargin: 'Optional. Image margin in pixels. Default: 0',
      dotsType: 'Optional. Dot style: square, rounded, dots, classy, classy-rounded, extra-rounded',
      cornersSquareType: 'Optional. Corner square style: dot, square, extra-rounded',
      cornersDotType: 'Optional. Corner dot style: dot, square',
      errorCorrectionLevel: 'Optional. Error correction: L (7%), M (15%), Q (25%), H (30%). Default: M',
      format: 'Optional. Output format: png, jpeg, or svg. Default: png',
    },
    example: {
      POST: {
        url: '/generate',
        body: {
          data: 'https://example.com',
          backgroundColor: '#ffffff',
          dotsColor: '#000000',
          dotsType: 'rounded',
          width: 400,
          height: 400,
          errorCorrectionLevel: 'H',
        },
      },
      GET: '/generate?data=https://example.com&dotsType=rounded&width=400',
    },
  });
});

async function shutdown() {
  if (browser) {
    await browser.close().catch(() => {});
  }
  process.exit();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

app.listen(PORT, () => {
  console.log(`QR API service running on port ${PORT}`);
});
