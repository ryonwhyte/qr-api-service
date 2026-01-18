# QR API Service

A Puppeteer-based API wrapper for [Mini QR](https://github.com/lyqht/mini-qr) that provides a REST API for generating customized QR codes.

## Deployment (Dokploy)

1. Create a new Compose project in Dokploy
2. Point to this repository
3. Deploy - Dokploy will build and run the services
4. Configure domain for the `qr-api` service (port 3000)

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
| `data` | string | **required** | The data to encode in the QR code |
| `logoUrl` | string | - | URL of logo image to embed in center |
| `backgroundColor` | string | `#ffffff` | Background color (hex) |
| `dotsColor` | string | `#000000` | Dots color (hex) |
| `cornersSquareColor` | string | - | Corners square color (hex) |
| `cornersDotColor` | string | - | Corners dot color (hex) |
| `width` | number | `300` | QR code width in pixels |
| `height` | number | `300` | QR code height in pixels |
| `borderRadius` | number | `0` | Border radius in pixels |
| `margin` | number | `10` | Margin in pixels |
| `imageMargin` | number | `0` | Logo image margin in pixels |
| `dotsType` | string | `square` | Dot style (see below) |
| `cornersSquareType` | string | `square` | Corner square style (see below) |
| `cornersDotType` | string | `square` | Corner dot style (see below) |
| `errorCorrectionLevel` | string | `M` | Error correction level (see below) |
| `format` | string | `png` | Output format: `png` or `jpeg` |

### Dot Types
- `square`
- `rounded`
- `dots`
- `classy`
- `classy-rounded`
- `extra-rounded`

### Corner Square Types
- `square`
- `rounded`
- `dots`
- `classy`
- `classy-rounded`
- `extra-rounded`

### Corner Dot Types
- `square`
- `rounded`
- `dot`

### Error Correction Levels
- `L` - Low (7%)
- `M` - Medium (15%)
- `Q` - High (25%)
- `H` - Highest (30%)

## Examples

### Basic QR Code
```bash
curl "https://your-domain.com/generate?data=Hello%20World" --output basic.png
```

### Styled QR Code with Logo
```bash
curl -X POST https://your-domain.com/generate \
  -H "Content-Type: application/json" \
  -d '{
    "data": "https://mywebsite.com",
    "logoUrl": "https://example.com/logo.png",
    "backgroundColor": "#f0f0f0",
    "dotsColor": "#333333",
    "cornersSquareColor": "#000000",
    "cornersDotColor": "#000000",
    "dotsType": "classy-rounded",
    "cornersSquareType": "rounded",
    "cornersDotType": "dot",
    "width": 500,
    "height": 500,
    "margin": 20,
    "imageMargin": 5,
    "errorCorrectionLevel": "H"
  }' \
  --output styled.png
```

### Health Check
```bash
curl https://your-domain.com/health
# {"status":"ok","service":"qr-api"}
```

## Local Development

```bash
docker-compose up -d
# API available at http://localhost:3000
```
