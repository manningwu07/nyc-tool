import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';

const server = await createServer({ root: '/Users/manningwu/Desktop/nyc/web', server: { port: 5199 } });
await server.listen();

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await page.setViewport({ width: 1400, height: 900 });
await page.goto('http://localhost:5199', { waitUntil: 'networkidle0', timeout: 30000 });
await new Promise((r) => setTimeout(r, 1500));

// open the Shortcuts tab
const clicked = await page.evaluate(() => {
  const btn = [...document.querySelectorAll('.tabs button')].find((b) => /shortcuts/i.test(b.textContent));
  if (!btn) return false;
  btn.click();
  return true;
});
console.log('shortcuts tab clicked:', clicked);
await new Promise((r) => setTimeout(r, 300));

// run the finder with defaults (walk, 2km, 15min, tips only)
await page.evaluate(() => {
  [...document.querySelectorAll('button')].find((b) => b.textContent === 'Find shortcuts')?.click();
});
await new Promise((r) => setTimeout(r, 3000));
const summary = await page.evaluate(() => {
  const h = [...document.querySelectorAll('h3')].map((x) => x.textContent);
  const firstRows = [...document.querySelectorAll('.opt')].slice(0, 5).map((x) => x.textContent.trim());
  return { headers: h, firstRows };
});
console.log(JSON.stringify(summary, null, 2));

// draft the top candidate
await page.evaluate(() => {
  [...document.querySelectorAll('button')].find((b) => b.textContent === '+ draft')?.click();
});
await new Promise((r) => setTimeout(r, 300));
const edges = await page.evaluate(() =>
  JSON.parse(localStorage.getItem('subway-speedrun-v1')).customTransfers);
console.log('customTransfers after draft:', JSON.stringify(edges));

await page.screenshot({ path: '/tmp/shortcuts.png' });
await browser.close();
await server.close();
