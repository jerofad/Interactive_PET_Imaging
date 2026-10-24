/* Browser smoke test for every page of the built site.

   Usage: npm run build && npm run test:e2e
   Options (environment): CHROME_PATH (default /usr/bin/google-chrome), SCREENSHOTS=1 to save
   screenshots at 375, 768 and 1440 px in light and dark themes to test-results/.

   Checks per page: no uncaught errors or console errors, the worker-driven figures finish, the
   3D scenes render (fallback hidden), and no horizontal page overflow at phone width. */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

const DIST = resolve('dist');
const BASE = '/pet/'; // serve under a subfolder to prove the relative base works
const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.gz': 'application/gzip',
  '.svg': 'image/svg+xml',
  '.xml': 'application/xml',
  '.txt': 'text/plain',
};

const server = createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (!path.startsWith(BASE)) return res.writeHead(404).end();
  path = path.slice(BASE.length);
  if (path === '' || path.endsWith('/')) path += 'index.html';
  try {
    const body = await readFile(join(DIST, path));
    res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, r));
const origin = `http://127.0.0.1:${server.address().port}${BASE}`;

// Each route lists text that must appear in a status element once its computation finishes.
const ROUTES = [
  ['', { status: [['heroStatus', /Complete/]] }],
  ['1-tracers/', { text: [['positronRead', /× 10/]] }],
  ['2-emission/', { text: [['noncolRead', /mm/]] }],
  ['3-detection/', { text: [['peakAcceptance', /%/]] }],
  ['4-coincidences/', { text: [['necrRead', /kcps/]], scenes: ['scanner', 'timeline'] }],
  ['5-data/', { text: [['benchIntegral', /a\.u\./]], scenes: ['bench'] }],
  ['6-tof/', { status: [['tofStatus', /Computed/]] }],
  ['7-corrections/', { status: [['acStatus', /Computed/]] }],
  ['8-reconstruction/', { scenes: ['film'], click: 'runBias', status: [['biasStatus', /Computed/]] }],
  [
    '9-image-quality/',
    { text: [['resolutionValue', /mm/]], click: 'runFractions', status: [['fractionStatus', /Computed/]] },
  ],
  ['10-artifacts/', { click: 'runArtifact', status: [['artifactStatus', /Computed/]] }],
  ['labs/scanner/', { scenes: ['scanner', 'bench', 'film', 'timeline'] }],
  ['labs/reconstruction/', { status: [['engineStatus', /Complete/]] }],
  [
    'labs/reconstruction/?preset=attenuation',
    { status: [['engineStatus', /Complete · MLEM/]], visible: ['presetNote'] },
  ],
  ['labs/viewer/', { text: [['voxelReadout', /a\.u\./]], status: [['mipStatus', /Projection at/]] }],
  ['reference/', { text: [] }],
];

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
let failures = 0;
// Polls with page.evaluate, which works under the site's strict CSP (Playwright's own wait helper needs eval).
async function waitForText(page, id, pattern, timeout) {
  const end = Date.now() + timeout;
  for (;;) {
    const text = await page.evaluate((id) => document.getElementById(id)?.textContent || '', id);
    if (pattern.test(text)) return;
    if (Date.now() > end) throw Error(`#${id} never matched ${pattern} (last: "${text.slice(0, 120)}")`);
    await page.waitForTimeout(250);
  }
}
async function waitForHidden(page, id, timeout) {
  const end = Date.now() + timeout;
  while (!(await page.evaluate((id) => document.getElementById(id)?.hidden === true, id))) {
    if (Date.now() > end) {
      const text = await page.evaluate((id) => document.getElementById(id)?.textContent || '', id);
      throw Error(`#${id} still visible: "${text}"`);
    }
    await page.waitForTimeout(250);
  }
}
const fail = (route, msg) => {
  failures++;
  console.log(`  ✗ ${route || '/'}: ${msg}`);
};

for (const [route, expect] of ROUTES) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push('console: ' + m.text()));
  const started = Date.now();
  await page.goto(origin + route, { waitUntil: 'load' });
  try {
    for (const [id, pattern] of expect.text || []) await waitForText(page, id, pattern, 20000);
    if (expect.click) await page.click('#' + expect.click);
    for (const [id, pattern] of expect.status || []) await waitForText(page, id, pattern, 120000);
    // 3D views are created when they scroll near the viewport.
    for (const key of expect.scenes || []) {
      await page.evaluate((id) => document.getElementById(id)?.scrollIntoView(), key + 'RecordFrame');
      await waitForHidden(page, key + 'Fallback', 30000);
    }
    for (const id of expect.visible || [])
      if (!(await page.isVisible('#' + id))) fail(route, `#${id} should be visible`);
  } catch (e) {
    fail(route, 'timed out waiting: ' + e.message.split('\n')[0]);
  }
  const alert = await page.$eval('#error', (el) => (el.hidden ? '' : el.textContent));
  if (alert) fail(route, 'error banner: ' + alert);
  for (const e of errors) fail(route, e);
  // No horizontal overflow on a phone.
  await page.setViewportSize({ width: 375, height: 800 });
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 1) fail(route, `horizontal overflow ${overflow}px at 375 px`);
  // The chapter navigation collapses behind the Contents button on phones.
  if (await page.isVisible('#siteNav')) fail(route, 'navigation should start collapsed at 375 px');
  await page.click('#menuButton');
  if (!(await page.isVisible('#siteNav'))) fail(route, 'Contents button did not open the navigation');
  await page.keyboard.press('Escape');
  if (process.env.SCREENSHOTS) {
    await mkdir('test-results', { recursive: true });
    const name = (route || 'home').replace(/[/?=]+/g, '_').replace(/_$/, '');
    for (const theme of ['light', 'dark'])
      for (const width of [375, 768, 1440]) {
        await page.emulateMedia({ colorScheme: theme });
        await page.setViewportSize({ width, height: 900 });
        await page.waitForTimeout(250);
        await page.screenshot({ path: `test-results/${name}-${width}-${theme}.png`, fullPage: true });
      }
  }
  console.log(
    `  ${errors.length || alert ? '✗' : '✓'} ${route || '/'} (${((Date.now() - started) / 1000).toFixed(1)} s)`,
  );
  await page.close();
}

await browser.close();
server.close();
console.log(failures ? `${failures} problem(s) found.` : 'All pages passed.');
process.exit(failures ? 1 : 0);
