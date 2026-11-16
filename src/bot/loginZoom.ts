import { chromium } from 'playwright';
import path from 'path';

async function main() {
  const userDataDir = path.resolve('./.bot-browser-data');
  console.log('====================================================');
  console.log('🔑 Zoom One-Time Sign-In for AI-agent');
  console.log(`📁 Profile directory: ${userDataDir}`);
  console.log('====================================================');
  console.log('Opening Zoom sign-in page in a visible browser...');
  console.log('👉 Please log into your Zoom account in the opened window.');
  console.log('👉 Once logged in, your session is saved permanently.');
  console.log('👉 Close the browser window or press Ctrl+C when finished.\n');

  const realisticUserAgent =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

  const context = await chromium
    .launchPersistentContext(userDataDir, {
      channel: 'chrome',
      headless: false,
      ignoreDefaultArgs: ['--enable-automation'],
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
      viewport: { width: 1280, height: 800 },
      userAgent: realisticUserAgent,
    })
    .catch(() => {
      return chromium.launchPersistentContext(userDataDir, {
        headless: false,
        ignoreDefaultArgs: ['--enable-automation'],
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
        viewport: { width: 1280, height: 800 },
        userAgent: realisticUserAgent,
      });
    });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = context.pages()[0] || (await context.newPage());
  await page.goto('https://zoom.us/signin', { waitUntil: 'domcontentloaded' });

  // Keep alive until user closes window
  page.on('close', () => {
    console.log('\n✅ Browser closed. Session saved to .bot-browser-data!');
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    console.log('\n[Main] Saving session and exiting...');
    await context.close();
    process.exit(0);
  });
}

main().catch(console.error);
