const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');

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

// Mapping for dot types
const DOT_TYPES = ['square', 'rounded', 'dots', 'classy', 'classy-rounded', 'extra-rounded'];
const CORNER_SQUARE_TYPES = ['square', 'rounded', 'dots', 'classy', 'classy-rounded', 'extra-rounded'];
const CORNER_DOT_TYPES = ['square', 'rounded', 'dot'];
const ERROR_CORRECTION_LEVELS = {
  'L': 'Low (7%)',
  'M': 'Medium (15%)',
  'Q': 'High (25%)',
  'H': 'Highest (30%)'
};

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
    await page.waitForSelector('input.text-input', { timeout: 10000 });

    // Clear and set the data to encode
    const dataInput = await page.$('input.text-input');
    await dataInput.click({ clickCount: 3 });
    await dataInput.type(data);

    // Helper function to set color input
    async function setColorInput(labelText, color) {
      const labels = await page.$$('label');
      for (const label of labels) {
        const text = await page.evaluate(el => el.textContent, label);
        if (text.includes(labelText)) {
          const parent = await label.evaluateHandle(el => el.closest('.flex'));
          const colorInput = await parent.$('input.color-input');
          if (colorInput) {
            await page.evaluate((input, value) => {
              input.value = value;
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.dispatchEvent(new Event('change', { bubbles: true }));
            }, colorInput, color);
          }
          break;
        }
      }
    }

    // Helper function to set text input by label
    async function setTextInputByLabel(labelText, value) {
      const labels = await page.$$('label');
      for (const label of labels) {
        const text = await page.evaluate(el => el.textContent, label);
        if (text.includes(labelText)) {
          const parent = await label.evaluateHandle(el => el.closest('.flex'));
          const input = await parent.$('input.text-input');
          if (input) {
            await input.click({ clickCount: 3 });
            await input.type(String(value));
          }
          break;
        }
      }
    }

    // Helper function to select radio option
    async function selectRadioOption(optionValue) {
      const labels = await page.$$('label');
      for (const label of labels) {
        const text = await page.evaluate(el => el.textContent?.trim(), label);
        if (text === optionValue) {
          await label.click();
          break;
        }
      }
    }

    // Expand all accordion sections to access all options
    const accordionButtons = await page.$$('button[data-state]');
    for (const btn of accordionButtons) {
      const state = await page.evaluate(el => el.getAttribute('data-state'), btn);
      if (state === 'closed') {
        await btn.click();
        await new Promise(r => setTimeout(r, 200));
      }
    }

    // Set Logo URL if provided
    if (logoUrl) {
      await setTextInputByLabel('Logo image URL', logoUrl);
    }

    // Set colors
    await setColorInput('Background color', backgroundColor);
    await setColorInput('Dots color', dotsColor);
    if (cornersSquareColor) {
      await setColorInput('Corners Square color', cornersSquareColor);
    }
    if (cornersDotColor) {
      await setColorInput('Corners Dot color', cornersDotColor);
    }

    // Set dimensions
    await setTextInputByLabel('Width', width);
    await setTextInputByLabel('Height', height);
    await setTextInputByLabel('Border radius', borderRadius);
    await setTextInputByLabel('Margin', margin);
    await setTextInputByLabel('Image margin', imageMargin);

    // Set dot type
    if (dotsType && DOT_TYPES.includes(dotsType)) {
      await selectRadioOption(dotsType);
    }

    // Set corner square type
    if (cornersSquareType && CORNER_SQUARE_TYPES.includes(cornersSquareType)) {
      await selectRadioOption(cornersSquareType);
    }

    // Set corner dot type
    if (cornersDotType && CORNER_DOT_TYPES.includes(cornersDotType)) {
      await selectRadioOption(cornersDotType);
    }

    // Set error correction level
    if (errorCorrectionLevel && ERROR_CORRECTION_LEVELS[errorCorrectionLevel]) {
      await selectRadioOption(ERROR_CORRECTION_LEVELS[errorCorrectionLevel]);
    }

    // Wait for QR code to regenerate
    await new Promise(r => setTimeout(r, 500));

    // Find the QR code container
    const qrContainer = await page.$('#element-to-export');

    if (!qrContainer) {
      throw new Error('QR code element not found');
    }

    // Return SVG markup or screenshot based on format
    if (format === 'svg') {
      const svgContent = await page.evaluate(() => {
        const svg = document.querySelector('#element-to-export svg');
        return svg ? svg.outerHTML : null;
      });
      if (!svgContent) {
        throw new Error('SVG element not found');
      }
      return Buffer.from(svgContent, 'utf-8');
    } else {
      const imageBuffer = await qrContainer.screenshot({
        type: format === 'png' ? 'png' : 'jpeg'
      });
      return imageBuffer;
    }

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
      cornersSquareType: 'Optional. Corner square style: square, rounded, dots, classy, classy-rounded, extra-rounded',
      cornersDotType: 'Optional. Corner dot style: square, rounded, dot',
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
