const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 3000;
const RENDER_SECRET = process.env.RENDER_SERVICE_SECRET;
const TEMPLATES_DIR = path.join(__dirname, 'templates');

let browser;
let browserLaunching = null;

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;

  if (browserLaunching) return browserLaunching;

  browserLaunching = puppeteer.launch({
    headless: 'new',
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  }).then((b) => {
    browser = b;
    browserLaunching = null;
    browser.on('disconnected', () => {
      console.error('Puppeteer browser disconnected. Will relaunch on next request.');
      browser = null;
    });
    return b;
  });

  return browserLaunching;
}

getBrowser()
  .then(() => console.log('Puppeteer browser warmed up and ready.'))
  .catch((err) => console.error('Failed to launch Puppeteer on startup:', err));

app.use((req, res, next) => {
  if (req.path === '/health') return next();

  const providedKey = req.get('x-render-key');
  if (!RENDER_SECRET || providedKey !== RENDER_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.post('/render', async (req, res) => {
  const { template, title, subtitle, icon, accent_color } = req.body || {};

  if (!template) {
    return res.status(400).json({ error: 'Missing required field: template' });
  }

  const templatePath = path.join(TEMPLATES_DIR, `${template}.html`);

  if (!fs.existsSync(templatePath)) {
    return res.status(400).json({ error: `Unknown template: "${template}"` });
  }

  let page;
  try {
    let html = fs.readFileSync(templatePath, 'utf8');

    html = html
      .replace(/{{TITLE}}/g, escapeHtml(title || ''))
      .replace(/{{SUBTITLE}}/g, escapeHtml(subtitle || ''))
      .replace(/{{ICON}}/g, escapeHtml(icon || ''))
      .replace(/{{ACCENT}}/g, accent_color || '#0E7C5A');

    const activeBrowser = await getBrowser();
    page = await activeBrowser.newPage();
    await page.setViewport({ width: 1200, height: 675, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 15000 });

    const buffer = await page.screenshot({ type: 'png' });

    res.set('Content-Type', 'image/png');
    res.send(buffer);
  } catch (err) {
    console.error('Render error:', err);
    res.status(500).json({ error: 'Failed to render image', details: err.message });
  } finally {
    if (page) {
      await page.close().catch(() => {});
    }
  }
});

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

app.listen(PORT, () => {
  console.log(`Render service listening on port ${PORT}`);
});

process.on('SIGTERM', async () => {
  console.log('SIGTERM received, closing browser and shutting down.');
  if (browser) await browser.close().catch(() => {});
  process.exit(0);
});
