// Captures README screenshots from a real Searvex HTML report (dev only; needs the Playwright devDependency).
//   node scripts/screenshots.mjs <report.html> [outDir=docs/assets]
// Every image is an unedited capture of the report file passed in.
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';

const [, , report, out = 'docs/assets'] = process.argv;
if (!report || !fs.existsSync(report)) {
  console.error('Usage: node scripts/screenshots.mjs <report.html> [outDir]');
  process.exit(2);
}
fs.mkdirSync(out, { recursive: true });
const url = 'file://' + path.resolve(report);
const browser = await chromium.launch();

async function shot(name, { lang = 'en', theme = 'light', width = 1280, height = 820, prepare } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: width < 600 ? 2 : 1.5, colorScheme: theme, locale: lang === 'tr' ? 'tr-TR' : 'en-US' });
  const page = await ctx.newPage();
  await page.goto(url);
  await page.evaluate(([l, t]) => {
    localStorage.setItem('searvex.lang', l);
    localStorage.setItem('searvex.theme', t);
  }, [lang, theme]);
  await page.goto(url);
  if (prepare) await prepare(page);
  const file = path.join(out, `${name}.png`);
  await page.screenshot({ path: file });
  await ctx.close();
  console.log(`${file} ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
}

const issues = async (page) => {
  await page.click('#tab-issues');
  await page.locator('.finding > input').first().check();
  await page.locator('.finding > input').nth(2).check();
  await page.locator('.finding details').first().evaluate((d) => (d.open = true));
};
const prompt = async (page) => {
  await issues(page);
  await page.click('#actionbar .btn.primary');
};

for (const theme of ['light', 'dark']) {
  await shot(`dashboard-${theme}`, { theme });
  await shot(`issues-${theme}`, { theme, prepare: issues });
  await shot(`prompt-${theme}`, { theme, prepare: prompt });
}
await shot('mobile-tr-dark', { lang: 'tr', theme: 'dark', width: 390, height: 844 });
await shot('dashboard-tr-light', { lang: 'tr', theme: 'light' });
await browser.close();
