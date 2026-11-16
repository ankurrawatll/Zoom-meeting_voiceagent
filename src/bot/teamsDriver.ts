import { Page } from 'playwright';

export interface TeamsJoinOptions {
  meetingUrl: string;
  botName: string;
  timeoutMs?: number;
}

export class TeamsDriver {
  private page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  /**
   * Automates joining a Microsoft Teams meeting via the Web Client.
   */
  public async join(options: TeamsJoinOptions): Promise<void> {
    console.log(`[TeamsDriver] Navigating to Teams meeting: ${options.meetingUrl}`);

    await this.page.goto(options.meetingUrl, {
      waitUntil: 'domcontentloaded',
      timeout: options.timeoutMs || 45000,
    });

    // 1. Choose "Continue on this browser" / "Join on the web instead"
    await this.selectWebClient();

    // 2. Dismiss cookie dialogs if any
    await this.dismissBanners();

    // 3. Enter guest display name
    await this.enterDisplayName(options.botName);

    // 4. Configure media toggles (turn camera off, keep mic enabled)
    await this.configureMediaDevices();

    // 5. Click "Join now"
    await this.clickJoinNow();

    // 6. Handle lobby/waiting room
    await this.handleLobby();

    console.log(`[TeamsDriver] 🚀 Successfully joined Microsoft Teams meeting as "${options.botName}"!`);
  }

  private async selectWebClient(): Promise<void> {
    console.log('[TeamsDriver] Checking for "Continue on this browser" prompt...');

    const webOptionSelectors = [
      'button[data-tid="joinOnWeb"]',
      'button:has-text("Continue on this browser")',
      'button:has-text("Join on the web instead")',
      'a:has-text("Continue on this browser")',
      'a:has-text("Join on the web instead")',
    ];

    for (let attempt = 0; attempt < 5; attempt++) {
      for (const sel of webOptionSelectors) {
        try {
          const btn = await this.page.$(sel);
          if (btn && (await btn.isVisible())) {
            console.log(`[TeamsDriver] Selected web client via: ${sel}`);
            await btn.click();
            await this.page.waitForTimeout(2000);
            return;
          }
        } catch (_) {}
      }
      await this.page.waitForTimeout(1000);
    }
  }

  private async dismissBanners(): Promise<void> {
    const banners = [
      'button:has-text("Accept")',
      'button:has-text("Got it")',
      'button[aria-label="Close"]',
    ];
    for (const sel of banners) {
      try {
        const btn = await this.page.$(sel);
        if (btn && (await btn.isVisible())) {
          await btn.click();
          break;
        }
      } catch (_) {}
    }
  }

  private async enterDisplayName(botName: string): Promise<void> {
    console.log(`[TeamsDriver] Entering display name: "${botName}"...`);

    const nameSelectors = [
      'input[data-tid="prejoin-display-name-input"]',
      'input[placeholder*="Type your name" i]',
      'input[aria-label*="name" i]',
      'input#username',
    ];

    for (const sel of nameSelectors) {
      try {
        await this.page.waitForSelector(sel, { timeout: 15000 });
        await this.page.fill(sel, botName);
        console.log(`[TeamsDriver] Filled display name in ${sel}`);
        return;
      } catch (_) {}
    }

    console.warn('[TeamsDriver] Display name input not found, checking if logged in or proceeding...');
  }

  private async configureMediaDevices(): Promise<void> {
    // 1. Turn camera off if toggled on
    try {
      const cameraBtn = await this.page.$(
        'div[data-tid="toggle-video"]:not([aria-checked="false"]), button[aria-label*="Turn camera off" i]'
      );
      if (cameraBtn && (await cameraBtn.isVisible())) {
        console.log('[TeamsDriver] Turning camera off...');
        await cameraBtn.click();
      }
    } catch (_) {}

    // 2. Ensure microphone is unmuted
    try {
      const muteBtn = await this.page.$(
        'div[data-tid="toggle-mute"][aria-checked="true"], button[aria-label*="Unmute microphone" i]'
      );
      if (muteBtn && (await muteBtn.isVisible())) {
        console.log('[TeamsDriver] Unmuting microphone...');
        await muteBtn.click();
      }
    } catch (_) {}
  }

  private async clickJoinNow(): Promise<void> {
    console.log('[TeamsDriver] Clicking "Join now"...');

    const joinSelectors = [
      'button[data-tid="prejoin-join-button"]',
      'button:has-text("Join now")',
      'button:has-text("Join")',
      '#prejoin-join-button',
    ];

    for (const sel of joinSelectors) {
      try {
        const btn = await this.page.waitForSelector(sel, { timeout: 10000 });
        if (btn && (await btn.isVisible())) {
          await btn.click();
          console.log(`[TeamsDriver] Clicked ${sel}`);
          return;
        }
      } catch (_) {}
    }
  }

  private async handleLobby(): Promise<void> {
    console.log('[TeamsDriver] Checking for lobby status...');

    const inCallSelector = '[data-tid="call-roster"], [data-tid="hangup-button"], button[aria-label*="Leave" i], #calling-canvas';
    const lobbySelector = ':text-matches("Someone in the meeting should let you in soon", "i"), :text-matches("let people in the meeting know", "i")';

    const maxWaitMs = 120000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      const inCall = await this.page.$(inCallSelector);
      if (inCall && (await inCall.isVisible())) {
        console.log('[TeamsDriver] 🚪 In Teams meeting stage!');
        return;
      }

      const lobby = await this.page.$(lobbySelector);
      if (lobby && (await lobby.isVisible())) {
        console.log('[TeamsDriver] ⏳ Bot is in lobby. Waiting for someone to admit...');
      }

      await this.page.waitForTimeout(3000);
    }
  }

  /**
   * Checks if bot is still in the meeting.
   */
  public async isInMeeting(): Promise<boolean> {
    try {
      const hangup = await this.page.$('[data-tid="hangup-button"], button[aria-label*="Leave" i]');
      return hangup !== null;
    } catch {
      return false;
    }
  }

  /**
   * Leaves the meeting.
   */
  public async leave(): Promise<void> {
    try {
      const hangup = await this.page.$('[data-tid="hangup-button"], button[aria-label*="Leave" i]');
      if (hangup) await hangup.click();
    } catch (_) {}
  }
}
