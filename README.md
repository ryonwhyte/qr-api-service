# QR API Service

A REST API for generating styled QR codes, rendered with
[qr-code-styling](https://github.com/kozakdenys/qr-code-styling) inside headless
Chromium.

## How it renders

The library is loaded into a blank local page and the image bytes are read straight
out of it. Nothing is fetched over the network while rendering and nothing touches the
filesystem, so concurrent requests cannot interfere with each other.

Earlier versions drove the [Mini QR](https://github.com/lyqht/mini-qr) web app in a
browser: set its form fields by element id, click its download button, then look in a
shared directory for the resulting file. That is gone. See [History](#history).

## Deployment (Dokploy)

1. Create a new Compose project in Dokploy
2. Point to this repository
3. Set environment variables:
   - `PORT` - API port (default: `3000`)
4. Deploy
5. Configure the domain for the `qr-api` service, target port **3000**

There is no longer a second container. `MINI_QR_URL` is no longer used and can be
removed from the project's environment.

## Checking it works

`GET /health` renders a real QR code and reports the result:

```bash
curl https://your-domain.com/health
# {"status":"ok","service":"qr-api","render":"ok","bytes":613}
```

It returns HTTP 503 with `"render":"failed"` when generation is broken, so it is
suitable for an uptime monitor. Compose declares it as the container healthcheck.

For a fuller check, the smoke test renders the shapes Cardyfi actually requests and
decodes the PNGs back to confirm they scan:

```bash
cd api && npm install
BASE=https://your-domain.com npm run smoke
```

It also fires eight concurrent requests and asserts each one gets its own code.

## API Usage

### Generate QR Code (POST)

```bash
curl -X POST https://your-domain.com/generate \
  -H "Content-Type: application/json" \
  -d '{
    "data": "https://example.com",
    "backgroundColor": "#ffffff",
    "dotsColor": "#000000",
    "dotsType": "rounded",
    "width": 400,
    "height": 400,
    "errorCorrectionLevel": "H"
  }' \
  --output qrcode.png
```

### Generate QR Code (GET)

```bash
curl "https://your-domain.com/generate?data=https://example.com&dotsType=rounded&width=400" \
  --output qrcode.png
```

## API Options

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `data` | string | **required** | The data to encode. Max 4296 characters |
| `logoUrl` | string | - | URL of logo image to embed in center. Max 2MB |
| `backgroundColor` | string | `#ffffff` | Background color (hex) |
| `dotsColor` | string | `#000000` | Dots color (hex) |
| `cornersSquareColor` | string | - | Corners square color (hex) |
| `cornersDotColor` | string | - | Corners dot color (hex) |
| `width` | number | `300` | Width in pixels, 32 to 2000 |
| `height` | number | `300` | Height in pixels, 32 to 2000 |
| `borderRadius` | number | - | Accepted and ignored, see below |
| `margin` | number | `10` | Margin in pixels |
| `imageMargin` | number | `0` | Logo image margin in pixels |
| `dotsType` | string | `square` | Dot style (see below) |
| `cornersSquareType` | string | `square` | Corner square style (see below) |
| `cornersDotType` | string | `square` | Corner dot style (see below) |
| `errorCorrectionLevel` | string | `M` | Error correction level (see below) |
| `format` | string | `png` | Output format: `png`, `jpeg`, or `svg` |

Out-of-range numbers are clamped and unrecognised styles fall back to the default,
so a bad parameter degrades instead of failing the request. A missing `data`, an
over-long `data`, or a `logoUrl` that cannot be loaded return HTTP 400 with a reason.

`borderRadius` styled the Mini QR preview container and never changed the exported
image. It is still accepted so existing callers do not break, and honouring it now
would change how every QR code already in circulation looks.

### Dot Types
- `square`
- `rounded`
- `dots`
- `classy`
- `classy-rounded`
- `extra-rounded`

### Corner Square Types
- `dot`
- `square`
- `extra-rounded`

### Corner Dot Types
- `dot`
- `square`

### Error Correction Levels
- `L` - Low (7%)
- `M` - Medium (15%)
- `Q` - High (25%)
- `H` - Highest (30%)

## Response Format

| Format | Content-Type | Response |
|--------|--------------|----------|
| `png` | `image/png` | Binary image data |
| `jpeg` | `image/jpeg` | Binary image data |
| `svg` | `image/svg+xml` | SVG XML text |

Errors return JSON with an `error` field: HTTP 400 for bad input, HTTP 500 for a
render failure. A response with an image Content-Type is always really that format;
PNG output is checked for its signature before being sent.

## Local Development

```bash
cd api
npm install
npm start           # http://localhost:3000
npm run smoke       # in another shell
```

Requires a Chromium that Puppeteer can launch. In Docker the image installs one and
`PUPPETEER_EXECUTABLE_PATH` points at it.

## History

On 6 November 2026 every PNG request began returning
`{"error":"Download failed - no file found"}` while SVG and JPEG kept working and
`/health` kept reporting ok. Nothing had been deployed. Three faults combined:

1. **`mini-qr` was pinned to `:latest`.** The service drove that app's UI by element
   id and depended on its download button producing a file. The image changed on a
   pull and its PNG export stopped downloading.
2. **One shared download directory, first matching file wins.** Concurrent requests
   raced. The loser reported no file, and a request could be served *another
   request's* QR code, which for a gift card is a redemption payload for the wrong
   card. This is the likely cause of the interleaved failures on 1 November.
3. **A two-second sleep instead of waiting for the download.** Chromium writes
   partial downloads as `.crdownload`, which never matches `.png`.

The rewrite removes the mechanism rather than patching it: no mini-qr, no element ids,
no downloads, no shared state. `/health` renders for real, the browser relaunches if
it dies, and the smoke test decodes what it renders.
