import { Page } from 'playwright';

export interface ZoomJoinOptions {
  meetingUrl: string;
  botName: string;
  passcode?: string;
  timeoutMs?: number;
}

export class ZoomDriver {
  private page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  /**
   * Transforms a standard Zoom invite link (e.g. https://zoom.us/j/1234567890?pwd=xyz)
   * into a direct Web Client URL (https://app.zoom.us/wc/{meetingId}/join?prefer=1&pwd=xyz).
   */
  public static normalizeZoomUrl(rawUrl: string, passcode?: string): string {
    try {
      const parsed = new URL(rawUrl);

      // Extract meeting ID from path (/j/123456789 or /wc/123456789/join)
      const jMatch = parsed.pathname.match(/\/(?:j|wc)\/(\d+)/);
      if (!jMatch) {
        // If already full wc url, ensure prefer=1 is appended
        if (rawUrl.includes('/wc/')) {
          parsed.searchParams.set('prefer', '1');
          return parsed.toString();
        }
        return rawUrl;
      }

      const meetingId = jMatch[1];
      const pwd = parsed.searchParams.get('pwd') || passcode || '';

      const wcUrl = new URL(`https://app.zoom.us/wc/${meetingId}/join`);
      wcUrl.searchParams.set('prefer', '1');
      if (pwd) wcUrl.searchParams.set('pwd', pwd);

      return wcUrl.toString();
    } catch {
      return rawUrl;
    }
  }

  /**
   * Automates joining a Zoom meeting via the web client.
   */
  public async join(options: ZoomJoinOptions): Promise<void> {
    const targetUrl = ZoomDriver.normalizeZoomUrl(options.meetingUrl, options.passcode);
    console.log(`[ZoomDriver] Navigating to Zoom Web Client: ${targetUrl}`);

    await this.page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: options.timeoutMs || 45000,
    });

    // 1. Dismiss cookies/terms if present
    await this.dismissCookieBanners();

    // 2. Handle Name and Passcode inputs
    await this.enterMeetingDetails(options.botName, options.passcode);

    // 3. Click Join button
    await this.clickJoinButton();

    // 4. Wait through waiting room (if host admission required)
    await this.handleWaitingRoom();

    // 5. Connect computer audio
    await this.connectComputerAudio();

    // 6. Ensure bot microphone is unmuted
    await this.ensureUnmuted();

    console.log(`[ZoomDriver] 🚀 Successfully joined Zoom meeting as "${options.botName}"!`);
  }

  private async dismissCookieBanners(): Promise<void> {
    const cookieSelectors = [
      '#onetrust-accept-btn-handler',
      'button:has-text("Accept All")',
      'button:has-text("Accept Cookies")',
      'button:has-text("I Agree")',
    ];

    for (const sel of cookieSelectors) {
      try {
        const btn = await this.page.$(sel);
        if (btn && (await btn.isVisible())) {
          await btn.click({ timeout: 2000 });
          console.log('[ZoomDriver] Dismissed cookie banner.');
          break;
        }
      } catch (_) {}
    }
  }

  private async enterMeetingDetails(botName: string, passcode?: string): Promise<void> {
    console.log(`[ZoomDriver] Entering display name: "${botName}"...`);

    // Zoom display name selectors
    const nameSelectors = [
      'input#input-for-name',
      'input[name="inputname"]',
      'input[placeholder*="name" i]',
      'input[aria-label*="name" i]',
    ];

    let filledName = false;
    for (const sel of nameSelectors) {
      try {
        const input = await this.page.waitForSelector(sel, { timeout: 15000 });
        if (input) {
          await input.click();
          await input.fill('');
          await this.page.keyboard.type(botName, { delay: 60 });
          filledName = true;
          break;
        }
      } catch (_) {}
    }

    if (!filledName) {
      console.warn('[ZoomDriver] Name input selector not found immediately, checking if already in meeting or alternate view...');
    }

    // Check if passcode is required
    const pwdSelectors = ['input#input-for-pwd', 'input[name="password"]', 'input[type="password"]'];
    for (const sel of pwdSelectors) {
      try {
        const pwdInput = await this.page.$(sel);
        if (pwdInput && (await pwdInput.isVisible()) && passcode) {
          console.log('[ZoomDriver] Entering meeting passcode...');
          await pwdInput.click();
          await pwdInput.fill('');
          await this.page.keyboard.type(passcode, { delay: 60 });
          break;
        }
      } catch (_) {}
    }

    await this.page.waitForTimeout(500);

    // Turn camera off on preview screen if active
    try {
      const stopVideoBtn = await this.page.$(
        'button:has-text("Stop Video"), .preview-video__control-button:has-text("Stop Video")'
      );
      if (stopVideoBtn && (await stopVideoBtn.isVisible())) {
        console.log('[ZoomDriver] 📷 Turning off camera on preview screen...');
        await stopVideoBtn.click();
      }
    } catch (_) {}
  }

  private async clickJoinButton(): Promise<void> {
    const joinSelectors = [
      'button.preview-join-button',
      'button:has-text("Join")',
      'button[type="submit"]',
      '.zm-btn--primary',
    ];

    for (const sel of joinSelectors) {
      try {
        const btn = await this.page.$(sel);
        if (btn && (await btn.isVisible())) {
          console.log(`[ZoomDriver] Clicking join button (${sel})...`);
          const box = await btn.boundingBox();
          if (box) {
            await this.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
            await this.page.waitForTimeout(100);
            await this.page.mouse.down();
            await this.page.waitForTimeout(80);
            await this.page.mouse.up();
          } else {
            await btn.click();
          }
          break;
        }
      } catch (_) {}
    }
  }

  private async handleWaitingRoom(): Promise<void> {
    console.log('[ZoomDriver] Checking for waiting room, host admission, or bot security alert...');

    const inMeetingSelector = '#foot-bar, [aria-label="Audio settings"], button[aria-label*="Mute" i], button[aria-label*="Join Audio" i]';
    const waitingRoomSelector = ':text-matches("host will let you in soon", "i"), :text-matches("waiting room", "i")';
    const botBlockedSelector = ':text-matches("Automated bots aren\'t allowed", "i")';

    const maxWaitMs = 120000; // 2 minutes wait for host to admit
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      // Check if blocked by Zoom Bot Policy
      const botBlocked = await this.page.$(botBlockedSelector);
      if (botBlocked && (await botBlocked.isVisible())) {
        console.error('\n⚠️ ============================================================');
        console.error('⚠️ [ZoomDriver] ZOOM BLOCKED GUEST ACCESS:');
        console.error('   "Automated bots aren\'t allowed to join this meeting."');
        console.error('   ------------------------------------------------------------');
        console.error('   How to resolve:');
        console.error('   1. In the Zoom host web settings (https://zoom.us/profile/setting):');
        console.error('      Turn OFF "Block automated bots from joining meetings".');
        console.error('   2. OR sign in once with any free Zoom account via:');
        console.error('      npm run login:zoom');
        console.error('      (Zoom allows authenticated users to join freely)');
        console.error('============================================================\n');
        throw new Error('Zoom host security policy blocked unauthenticated bot.');
      }

      const inMeeting = await this.page.$(inMeetingSelector);
      if (inMeeting && (await inMeeting.isVisible())) {
        console.log('[ZoomDriver] 🚪 In meeting room!');
        return;
      }

      const waiting = await this.page.$(waitingRoomSelector);
      if (waiting && (await waiting.isVisible())) {
        console.log('[ZoomDriver] ⏳ Bot is in waiting room. Waiting for host admission...');
      }

      await this.page.waitForTimeout(2000);
    }
  }

  private async connectComputerAudio(): Promise<void> {
    console.log('[ZoomDriver] 🔊 Connecting computer audio...');

    const audioPromptSelectors = [
      'button:has-text("Join Audio by Computer")',
      'button.join-audio-by-computer',
      'button:has-text("Computer Audio")',
      'button:has-text("Join with Computer Audio")',
      'button:has-text("Connect Audio")',
      'button.zm-btn--primary:has-text("Computer")',
    ];

    for (let attempt = 0; attempt < 25; attempt++) {
      // 1. Check if "Join Audio by Computer" modal is open
      for (const sel of audioPromptSelectors) {
        try {
          const btn = await this.page.$(sel);
          if (btn && (await btn.isVisible())) {
            console.log(`[ZoomDriver] 🔊 Clicked audio modal button: ${sel}`);
            await btn.click();
            await this.page.waitForTimeout(2000);
            return;
          }
        } catch (_) {}
      }

      // 2. Check if bottom toolbar has "Join Audio" icon (headphones)
      try {
        const toolbarJoinBtn = await this.page.$(
          'button[aria-label*="join audio" i], .join-audio-icon, button:has-text("Join Audio")'
        );
        if (toolbarJoinBtn && (await toolbarJoinBtn.isVisible())) {
          console.log('[ZoomDriver] 🔊 Clicking toolbar "Join Audio" button to open modal...');
          await toolbarJoinBtn.click();
          await this.page.waitForTimeout(1000);
        }
      } catch (_) {}

      // 3. Check if microphone is already connected (either Mute or Unmute button is present)
      const micBtn = await this.page.$(
        'button[aria-label*="mute my microphone" i], button[aria-label*="unmute" i]'
      );
      if (micBtn && (await micBtn.isVisible())) {
        console.log('[ZoomDriver] 🎙️ Audio stream is connected in meeting.');
        return;
      }

      await this.page.waitForTimeout(1500);
    }
  }

  private async dismissMicrophoneWarning(): Promise<void> {
    const bannerSelectors = [
      '[role="alert"] button',
      '.zm-alert-close',
      'button[aria-label*="close" i]',
      'div:has-text("Your microphone is not working") button',
      'div:has-text("Your microphone is not working") [role="button"]',
      'div:has-text("Your microphone is not working") .zm-icon-close',
      ':text-matches("Your microphone is not working", "i") button',
    ];

    for (const sel of bannerSelectors) {
      try {
        const btn = await this.page.$(sel);
        if (btn && (await btn.isVisible())) {
          console.log(`[ZoomDriver] ⚠️ Dismissed microphone warning banner (${sel}).`);
          await btn.click({ force: true });
          await this.page.waitForTimeout(400);
          break;
        }
      } catch (_) {}
    }
  }

  private async selectMicrophoneDevice(): Promise<void> {
    console.log('[ZoomDriver] 🎙️ Checking microphone device selection in Zoom...');

    const micItemSelectors = [
      'li:has-text("Fake Default Audio Input")',
      'button:has-text("Fake Default Audio Input")',
      'span:has-text("Fake Default Audio Input")',
      'div:has-text("Fake Default Audio Input")',
      'a:has-text("Fake Default Audio Input")',
      ':text-matches("Fake Default Audio Input", "i")',
    ];

    let found = false;
    for (const sel of micItemSelectors) {
      try {
        const item = await this.page.$(sel);
        if (item && (await item.isVisible())) {
          console.log(`[ZoomDriver] 🎙️ Selecting microphone device from menu: ${sel}`);
          await item.click({ force: true });
          found = true;
          await this.page.waitForTimeout(1000);
          break;
        }
      } catch (_) {}
    }

    if (!found) {
      const menuTriggerSelectors = [
        'button[aria-label*="audio settings" i]',
        'button[aria-label*="Select a Microphone" i]',
        '#foot-bar .dropdown-toggle',
        'button.audio-settings-icon',
        'button.zm-btn-more',
        'button[aria-label*="Audio" i] ~ button',
      ];

      for (const sel of menuTriggerSelectors) {
        try {
          const trigger = await this.page.$(sel);
          if (trigger && (await trigger.isVisible())) {
            console.log(`[ZoomDriver] 🎙️ Opening audio settings menu via ${sel}...`);
            await trigger.click();
            await this.page.waitForTimeout(800);

            for (const itemSel of micItemSelectors) {
              const item = await this.page.$(itemSel);
              if (item && (await item.isVisible())) {
                console.log(`[ZoomDriver] 🎙️ Selected microphone device: ${itemSel}`);
                await item.click({ force: true });
                found = true;
                await this.page.waitForTimeout(1000);
                break;
              }
            }
            if (found) break;
          }
        } catch (_) {}
      }
    }

    await this.dismissMicrophoneWarning();
  }

  private async ensureUnmuted(): Promise<void> {
    console.log('[ZoomDriver] 🎙️ Verifying microphone is unmuted...');

    // 1. Dismiss any warning banner
    await this.dismissMicrophoneWarning();

    // 2. Select microphone device if audio menu is present or if device isn't selected
    await this.selectMicrophoneDevice();

    // 3. Confirm microphone is unmuted
    for (let i = 0; i < 15; i++) {
      await this.dismissMicrophoneWarning();

      try {
        // If "Unmute" button is visible, click it!
        const unmuteBtn = await this.page.$(
          'button[aria-label*="unmute" i], .unmute-icon, button:has-text("Unmute")'
        );
        if (unmuteBtn && (await unmuteBtn.isVisible())) {
          console.log('[ZoomDriver] 🎙️ Bot was muted in Zoom. Clicking Unmute...');
          await unmuteBtn.click({ force: true });
          await this.page.waitForTimeout(1000);
          continue;
        }

        // If bottom toolbar says "Audio" (meaning not connected or in error), click it to connect
        const audioBtn = await this.page.$(
          'button[aria-label*="join audio" i], .join-audio-icon, button:has-text("Join Audio")'
        );
        if (audioBtn && (await audioBtn.isVisible())) {
          console.log('[ZoomDriver] 🔊 Re-joining audio...');
          await audioBtn.click();
          await this.page.waitForTimeout(1000);
          await this.connectComputerAudio();
          await this.selectMicrophoneDevice();
          continue;
        }

        // If "Mute" button is visible, mic is actively unmuted
        const muteBtn = await this.page.$(
          'button[aria-label*="mute my microphone" i], button[aria-label="Mute"]'
        );
        if (muteBtn && (await muteBtn.isVisible())) {
          console.log('[ZoomDriver] 🎙️ Microphone is active and unmuted.');
          break;
        }
      } catch (_) {}

      await this.page.waitForTimeout(800);
    }

    // Ensure camera is turned off inside meeting
    try {
      const stopVideoBtn = await this.page.$('button[aria-label*="stop video" i]');
      if (stopVideoBtn && (await stopVideoBtn.isVisible())) {
        console.log('[ZoomDriver] 📷 Turning off video in meeting...');
        await stopVideoBtn.click();
      }
    } catch (_) {}
  }

  /**
   * Periodically checks if the meeting has ended or the bot was disconnected.
   */
  public async isInMeeting(): Promise<boolean> {
    try {
      const ended = await this.page.$(':text-matches("This meeting has been ended", "i")');
      if (ended && (await ended.isVisible())) return false;

      const footBar = await this.page.$('#foot-bar, [aria-label="Audio settings"]');
      return footBar !== null;
    } catch {
      return false;
    }
  }

  /**
   * Leaves the meeting cleanly.
   */
  public async leave(): Promise<void> {
    try {
      const leaveBtn = await this.page.$('button:has-text("Leave"), button[aria-label*="Leave" i]');
      if (leaveBtn) {
        await leaveBtn.click();
        const confirmLeave = await this.page.$('button:has-text("Leave Meeting")');
        if (confirmLeave) await confirmLeave.click();
      }
    } catch (_) {}
  }
}
