import { chromium } from 'playwright';

async function testStealth() {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: false,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
    ],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();
  await page.goto('https://bot.sannysoft.com', { waitUntil: 'networkidle' });

  const webdriverPresent = await page.evaluate(() => (navigator as any).webdriver);
  console.log('navigator.webdriver:', webdriverPresent);

  const results = await page.$$eval('table tr', (rows) =>
    rows.map((r) => r.innerText.replace(/\s+/g, ' ').trim())
  );

  console.log('--- Key Detection Flags ---');
  results
    .filter((r) => r.includes('WebDriver') || r.includes('Chrome') || r.includes('Permissions') || r.includes('Plugins'))
    .forEach((r) => console.log('  ', r));

  await browser.close();
}

testStealth().catch(console.error);
