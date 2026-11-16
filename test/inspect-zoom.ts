import { chromium } from 'playwright';
import path from 'path';

async function inspectZoom() {
  const url = 'https://app.zoom.us/wc/72859649752/join?prefer=1&pwd=FZabDTDje2HBAHEfmD8qq3GP5Dy5ni.1';
  console.log('Navigating to:', url);

  const userDataDir = path.resolve('./.chrome-bot-profile');
  console.log('Using persistent user data dir:', userDataDir);

  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chrome',
    headless: false,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
    ],
    permissions: ['microphone', 'camera'],
    viewport: { width: 1280, height: 720 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  await context.addInitScript(() => {
    // 1. Overwrite navigator.webdriver
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

    // 2. Mock window.chrome
    if (!(window as any).chrome) {
      (window as any).chrome = {
        runtime: {},
        app: {},
        csi: () => {},
        loadTimes: () => {},
      };
    }

    // 3. Mock navigator.plugins
    Object.defineProperty(navigator, 'plugins', {
      get: () => [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
        { name: 'Native Client', filename: 'internal-nacl-plugin' },
      ],
    });

    // 4. Mock navigator.languages
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
    });

    // 5. Overwrite permissions query
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) =>
      parameters.name === 'notifications'
        ? Promise.resolve({ state: 'denied' } as PermissionStatus)
        : originalQuery(parameters);
  });

  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

  console.log('Navigated. Waiting for input#input-for-name...');
  await page.waitForSelector('input#input-for-name', { timeout: 20000 });

  // Natural human typing
  console.log('Focusing and typing name with human delay...');
  const nameInput = await page.$('input#input-for-name');
  if (nameInput) {
    const box = await nameInput.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 10 });
      await page.mouse.down();
      await page.mouse.up();
    }
    await page.keyboard.type('bot AI', { delay: 150 });
  }

  await page.waitForTimeout(1000);

  // Natural human click on Join button
  const joinBtn = await page.$('button.preview-join-button');
  if (joinBtn) {
    console.log('Hovering and clicking Join button naturally...');
    const btnBox = await joinBtn.boundingBox();
    if (btnBox) {
      await page.mouse.move(btnBox.x + btnBox.width / 2, btnBox.y + btnBox.height / 2, { steps: 15 });
      await page.waitForTimeout(300);
      await page.mouse.down();
      await page.waitForTimeout(80);
      await page.mouse.up();
    }
  }

  console.log('Waiting 8 seconds to see result...');
  await page.waitForTimeout(8000);

  console.log('Current URL:', page.url());
  console.log('Current Title:', await page.title());
  await page.screenshot({ path: 'zoom_stealth_result.png' });

  const bodySnippet = await page.$eval('body', (el) => el.innerText.substring(0, 500).replace(/\n+/g, ' '));
  console.log('Body text snippet after stealth join:', bodySnippet);

  await context.close();
}

inspectZoom().catch(console.error);
