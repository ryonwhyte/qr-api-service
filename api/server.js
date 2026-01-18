const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const MINI_QR_URL = process.env.MINI_QR_URL || 'http://mini-qr:80';
const PORT = process.env.PORT || 3000;

// Browser instance (reused for performance)
let browser = null;

async function getBrowser() {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--ignore-certificate-errors',
        '--disable-web-security',
        '--allow-running-insecure-content'
      ]
    });
  }
  return browser;
}

// Valid option values (matching mini-qr HTML)
const DOT_TYPES = ['dots', 'rounded', 'classy', 'classy-rounded', 'square', 'extra-rounded'];
const CORNER_SQUARE_TYPES = ['dot', 'square', 'extra-rounded'];
const CORNER_DOT_TYPES = ['dot', 'square'];
const ERROR_CORRECTION_LEVELS = ['L', 'M', 'Q', 'H'];

async function generateQRCode(options) {
  const {
    data,
    logoUrl,
    backgroundColor = '#ffffff',
    dotsColor = '#000000',
    cornersSquareColor,
    cornersDotColor,
    width = 300,
    height = 300,
    borderRadius = 0,
    margin = 10,
    imageMargin = 0,
    dotsType = 'square',
    cornersSquareType = 'square',
    cornersDotType = 'square',
    errorCorrectionLevel = 'M',
    format = 'png'
  } = options;

  if (!data) {
    throw new Error('Data to encode is required');
  }

  const browserInstance = await getBrowser();
  const page = await browserInstance.newPage();

  try {
    // Set viewport
    await page.setViewport({ width: 1280, height: 900 });

    // Navigate to Mini QR
    await page.goto(MINI_QR_URL, { waitUntil: 'networkidle0', timeout: 30000 });

    // Wait for the app to load
    await page.waitForSelector('#data', { timeout: 10000 });

    // Helper: Set text/number input by ID
    async function setInputById(id, value) {
      const input = await page.$(`#${id}`);
      if (input) {
        // Set value directly and dispatch events to trigger reactivity
        await page.evaluate((el, val) => {
          el.value = val;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, input, String(value));
      }
    }

    // Helper: Set color input by ID
    async function setColorById(id, color) {
      const input = await page.$(`#${id}`);
      if (input) {
        await page.evaluate((el, value) => {
          el.value = value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, input, color);
      }
    }

    // Helper: Click radio by ID
    async function selectRadioById(id) {
      const radio = await page.$(`#${id}`);
      if (radio) {
        await radio.click();
      }
    }

    // Set data to encode
    await setInputById('data', data);

    // Set logo URL if provided
    if (logoUrl) {
      await setInputById('image-url', logoUrl);
    }

    // Set colors
    await setColorById('background-color', backgroundColor);
    await setColorById('dots-color', dotsColor);
    if (cornersSquareColor) {
      await setColorById('corners-square-color', cornersSquareColor);
    }
    if (cornersDotColor) {
      await setColorById('corners-dot-color', cornersDotColor);
    }

    // Set dimensions
    await setInputById('width', width);
    await setInputById('height', height);
    await setInputById('border-radius', borderRadius);
    await setInputById('margin', margin);
    await setInputById('image-margin', imageMargin);

    // Set dot type
    if (dotsType && DOT_TYPES.includes(dotsType)) {
      await selectRadioById(`dotsOptionsType-${dotsType}`);
    }

    // Set corner square type
    if (cornersSquareType && CORNER_SQUARE_TYPES.includes(cornersSquareType)) {
      await selectRadioById(`cornersSquareOptionsType-${cornersSquareType}`);
    }

    // Set corner dot type
    if (cornersDotType && CORNER_DOT_TYPES.includes(cornersDotType)) {
      await selectRadioById(`cornersDotOptionsType-${cornersDotType}`);
    }

    // Set error correction level
    if (errorCorrectionLevel && ERROR_CORRECTION_LEVELS.includes(errorCorrectionLevel)) {
      await selectRadioById(`errorCorrectionLevel-${errorCorrectionLevel}`);
    }

    // Wait for QR code to regenerate at new size
    await new Promise(r => setTimeout(r, 1000));

    // Set up download behavior
    const downloadPath = '/tmp/qr-downloads';
    await fs.mkdir(downloadPath, { recursive: true });

    const client = await page.createCDPSession();
    await client.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: downloadPath,
    });

    // Click the appropriate download button
    const buttonId = format === 'svg'
      ? 'download-qr-image-button-svg'
      : format === 'jpeg'
        ? 'download-qr-image-button-jpg'
        : 'download-qr-image-button-png';

    await page.click(`#${buttonId}`);

    // Wait for download to complete
    await new Promise(r => setTimeout(r, 2000));

    // Find the downloaded file
    const files = await fs.readdir(downloadPath);
    const ext = format === 'jpeg' ? 'jpg' : format;
    const downloadedFile = files.find(f => f.endsWith(`.${ext}`));

    if (!downloadedFile) {
      throw new Error('Download failed - no file found');
    }

    const filePath = path.join(downloadPath, downloadedFile);
    const imageBuffer = await fs.readFile(filePath);

    // Clean up
    await fs.unlink(filePath);

    return imageBuffer;

  } finally {
    await page.close();
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'qr-api' });
});

// Generate QR code endpoint
app.post('/generate', async (req, res) => {
  try {
    const imageBuffer = await generateQRCode(req.body);
    const format = req.body.format || 'png';
    const contentType = format === 'svg' ? 'image/svg+xml' : `image/${format}`;

    res.set('Content-Type', contentType);
    res.set('Content-Disposition', `attachment; filename="qrcode.${format}"`);
    res.send(imageBuffer);
  } catch (error) {
    console.error('Error generating QR code:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET endpoint for simple usage
app.get('/generate', async (req, res) => {
  try {
    const options = {
      data: req.query.data,
      logoUrl: req.query.logoUrl,
      backgroundColor: req.query.backgroundColor,
      dotsColor: req.query.dotsColor,
      cornersSquareColor: req.query.cornersSquareColor,
      cornersDotColor: req.query.cornersDotColor,
      width: req.query.width ? parseInt(req.query.width) : undefined,
      height: req.query.height ? parseInt(req.query.height) : undefined,
      borderRadius: req.query.borderRadius ? parseInt(req.query.borderRadius) : undefined,
      margin: req.query.margin ? parseInt(req.query.margin) : undefined,
      imageMargin: req.query.imageMargin ? parseInt(req.query.imageMargin) : undefined,
      dotsType: req.query.dotsType,
      cornersSquareType: req.query.cornersSquareType,
      cornersDotType: req.query.cornersDotType,
      errorCorrectionLevel: req.query.errorCorrectionLevel,
      format: req.query.format
    };

    const imageBuffer = await generateQRCode(options);
    const format = options.format || 'png';
    const contentType = format === 'svg' ? 'image/svg+xml' : `image/${format}`;

    res.set('Content-Type', contentType);
    res.send(imageBuffer);
  } catch (error) {
    console.error('Error generating QR code:', error);
    res.status(500).json({ error: error.message });
  }
});

// API documentation endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'QR Code API',
    version: '1.0.0',
    endpoints: {
      'GET /health': 'Health check',
      'POST /generate': 'Generate QR code with full options',
      'GET /generate': 'Generate QR code with query parameters'
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
      borderRadius: 'Optional. Border radius in pixels. Default: 0',
      margin: 'Optional. Margin in pixels. Default: 10',
      imageMargin: 'Optional. Image margin in pixels. Default: 0',
      dotsType: 'Optional. Dot style: square, rounded, dots, classy, classy-rounded, extra-rounded',
      cornersSquareType: 'Optional. Corner square style: dot, square, extra-rounded',
      cornersDotType: 'Optional. Corner dot style: dot, square',
      errorCorrectionLevel: 'Optional. Error correction: L (7%), M (15%), Q (25%), H (30%). Default: M',
      format: 'Optional. Output format: png, jpeg, or svg. Default: png'
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
          errorCorrectionLevel: 'H'
        }
      },
      GET: '/generate?data=https://example.com&dotsType=rounded&width=400'
    }
  });
});

// Graceful shutdown
process.on('SIGINT', async () => {
  if (browser) {
    await browser.close();
  }
  process.exit();
});

app.listen(PORT, () => {
  console.log(`QR API service running on port ${PORT}`);
});
