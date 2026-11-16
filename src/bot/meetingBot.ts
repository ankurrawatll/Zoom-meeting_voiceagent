import { chromium, Browser, BrowserContext, Page } from 'playwright';
import path from 'path';
import { EventEmitter } from 'events';
import { AudioBridge } from '../audio/audioBridge.js';
import { WasapiCapture } from '../audio/wasapiCapture.js';
import { getInjectAudioHookScript } from '../audio/injectAudioHook.js';
import { GeminiLiveClient } from '../ai/geminiLiveClient.js';
import { ZoomDriver } from './zoomDriver.js';
import { TeamsDriver } from './teamsDriver.js';
import { config, validateConfig } from '../config/env.js';

export type MeetingPlatform = 'zoom' | 'teams' | 'auto';
export type InteractionMode = 'continuous' | 'wake_word';

export interface MeetingBotOptions {
  meetingUrl: string;
  platform?: MeetingPlatform;
  botName?: string;
  passcode?: string;
  voiceName?: string;
  systemPrompt?: string;
  headless?: boolean;
  greeting?: string;
  interactionMode?: InteractionMode;
  wakeWords?: string[];
  wakeTimeoutSeconds?: number;
}

export class MeetingBot extends EventEmitter {
  private options: MeetingBotOptions;
  private audioBridge: AudioBridge | null = null;
  private wasapiCapture: WasapiCapture | null = null;
  private geminiClient: GeminiLiveClient | null = null;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private isRunning = false;

  // Wake-word & directed response gating state
  private isWakeWordMode = false;
  private wakeWords: string[] = [];
  private wakeWordRegex: RegExp | null = null;
  private isAwake = false;
  private wakeTimeoutTimer: NodeJS.Timeout | null = null;
  private wakeTimeoutSeconds = 15;
  private isDeliveringOpeningGreeting = false;

  // Complete conversational transcript history for post-meeting evaluation & scoring
  private transcriptHistory: Array<{ speaker: 'user' | 'bot'; text: string; timestamp: number }> = [];
  private meetingStartTime: number = 0;

  constructor(options: MeetingBotOptions) {
    super();
    this.options = {
      platform: 'auto',
      botName: config.botName,
      voiceName: config.botVoice,
      headless: config.headless,
      interactionMode: 'continuous',
      ...options,
    };
    validateConfig();

    this.isWakeWordMode = this.options.interactionMode === 'wake_word';
    this.wakeTimeoutSeconds = this.options.wakeTimeoutSeconds || 15;

    if (this.isWakeWordMode) {
      const defaultName = (this.options.botName || 'Alex').trim().toLowerCase();
      const rawWords = (this.options.wakeWords && this.options.wakeWords.length > 0)
        ? this.options.wakeWords
        : [`hey ${defaultName}`, defaultName, 'hey ai', 'ai-agent', 'ai agent', 'alex'];

      this.wakeWords = rawWords.map((w) => w.trim().toLowerCase()).filter(Boolean);

      // Support English variations, common speech-to-text mishearings, and Indic/Devanagari phonetic spellings
      const phoneticTriggers = [
        'hey alex', 'alex', 'alix', 'alek', 'elix', 'hey assistant', 'assistant', 'ai agent', 'ai-agent',
        'एलेक्स', 'एल एक्स', 'एल-एक्स', 'एलिक्स', 'हे एलेक्स', 'हेय एलेक्स', 'ഹേയ് അലക്സ്', 'അലക്സ്'
      ];
      this.wakeWords = Array.from(new Set([...this.wakeWords, ...phoneticTriggers]));
      const escaped = this.wakeWords.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
      this.wakeWordRegex = new RegExp(`(?:^|[\\s.,!?;])(${escaped})(?:[\\s.,!?;]|$)`, 'iu');
      this.isAwake = false; // Start in silent standby
    } else {
      this.isAwake = true; // Always active in continuous conversation mode
    }
  }

  public detectPlatform(url: string): 'zoom' | 'teams' {
    if (url.includes('zoom.us')) return 'zoom';
    if (url.includes('teams.microsoft.com') || url.includes('teams.live.com')) return 'teams';
    // Default fallback
    return 'zoom';
  }

  /**
   * Starts the complete Voice Agent pipeline:
   * 1. AudioBridge WebSocket Server
   * 2. Gemini Live WebSocket Connection
   * 3. Playwright Chromium with virtual media devices & injected audio hook
   * 4. Platform driver automation (Zoom or Teams)
   */
  public async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    this.meetingStartTime = Date.now();
    this.transcriptHistory = [];

    console.log('====================================================');
    console.log(`🤖 Starting AI-agent: "${this.options.botName}"`);
    console.log(`🎙️ Gemini Voice: "${this.options.voiceName || config.botVoice}"`);
    console.log(`🔗 Target URL: ${this.options.meetingUrl}`);
    console.log('====================================================');

    this.emit('status', { state: 'connecting', message: `Initializing AudioBridge & Gemini Live (Voice: ${this.options.voiceName || config.botVoice})...` });
    this.emit('log', { message: `Starting Voice Agent "${this.options.botName}" (Voice: ${this.options.voiceName || config.botVoice}) for ${this.options.meetingUrl}`, level: 'info' });

    // 1. Start Audio Bridge
    this.audioBridge = new AudioBridge({ port: config.audioBridgePort });
    await this.audioBridge.start();

    // 2. Start Gemini Live WebSocket client
    let systemPrompt =
      this.options.systemPrompt ||
      `You are ${this.options.botName || 'Alex'}, an experienced, warm, and empathetic Tech Venture Capital & Angel Investor in a 1-on-1 pitch conversation with a startup founder.\n\n` +
      'PITCH MEETING PHASES (PROGRESS NATURALLY THROUGH THESE PHASES):\n' +
      '• PHASE 1: WARM INTRO & RAPPORT (Start here):\n' +
      '  - Greet the founder warmly as a peer. Ask how they are doing and where they are joining from.\n' +
      '  - DO NOT jump straight into asking business metrics or questioning their idea right away. Build personal rapport first.\n\n' +
      '• PHASE 2: CONTEXT & VISION (After initial greeting):\n' +
      '  - Gently invite them to share their vision: "Whenever you\'re ready, I\'d love to hear the story behind what you\'re building."\n' +
      '  - Let them speak freely and listen attentively.\n\n' +
      '• PHASE 3: ACTIVE REFLECTIVE LISTENING (CRITICAL - DO THIS EVERY SINGLE TURN):\n' +
      '  - When the founder speaks, ALWAYS demonstrate deep understanding by first reflecting, summarizing, or validating their exact points before saying anything else.\n' +
      '  - Example: "Ah, I see! So you\'re in the ideation phase working on plastic-free solutions, starting with regulatory clearances. That is an ambitious problem to solve, and day-zero ideation is where every breakthrough begins."\n' +
      '  - If they say they do not have traction or are just starting out, be completely supportive and respectful. Never make them feel pressured or defensive.\n\n' +
      '• PHASE 4: COLLABORATIVE DIALOGUE (NOT AN INTERROGATION):\n' +
      '  - NEVER barrage the founder with multiple questions in a row. You are a brainstorming partner having coffee, not a courtroom interrogator.\n' +
      '  - Share an investor observation or encouraging insight, then ask at most ONE open-ended, friendly question to explore together.\n\n' +
      '• PHASE 5: SUPPORTIVE WRAP-UP:\n' +
      '  - When closing, highlight what you find exciting about their approach and offer encouraging, actionable takeaways.\n\n' +
      'KEY CONVERSATIONAL RULES:\n' +
      '1. MIRROR AND VALIDATE FIRST: Never give a reply that doesn\'t reference what the founder just said.\n' +
      '2. ONE QUESTION AT MOST: Never stack questions. Keep questions open, friendly, and collaborative.\n' +
      '3. CONCISE & SPOKEN: Keep spoken turns to 2 to 3 sentences maximum. Natural, spoken pace.\n' +
      '4. MULTILINGUAL EMPATHY: The founder may mix English, Hindi, or Hinglish words (e.g. "ideation face", "प्लास्टिक फ्री"). Understand their exact meaning naturally and respond in warm, fluent conversational English.\n' +
      '5. SNAPPY TURN-TAKING: Respond promptly as soon as the founder finishes speaking.\n' +
      '6. MOVE FORWARD FROM INTROS: Once you have greeted the founder, or as soon as the founder begins sharing their idea, thoughts, or startup topic, IMMEDIATELY move out of introductions into Phase 2 (Context & Vision) and Phase 3 (Active Listening). Encourage them to pitch freely: "I\'d love to hear all about it. Go ahead and walk me through your vision!" NEVER repeat the introductory greeting.\n' +
      '7. ENGLISH TRANSCRIPTION & SPEECH: All transcriptions and spoken responses must strictly use the standard English Latin alphabet. Never transcribe or respond in Devanagari script.';

    if (this.isWakeWordMode) {
      const triggerList = this.wakeWords.map((w) => `"${w}"`).join(', ');
      console.log(`🎯 [MeetingBot] Wake-Word Mode ENABLED. Configured triggers: ${triggerList}`);
      systemPrompt +=
        `\n\n[STRICT TRIGGER RULE - WAKE WORD STANDBY MODE ACTIVE]:\n` +
        `You are participating in a group meeting where participants talk amongst themselves.\n` +
        `CRITICAL SILENCE POLICY:\n` +
        `- You must REMAIN COMPLETELY SILENT and output NO AUDIO / NO SPEECH while other participants speak.\n` +
        `- You are ONLY permitted to speak if a participant explicitly calls your name or addresses you using any of these wake phrases: ${triggerList}.\n` +
        `- When addressed: answer helpfully, politely, and concisely (1 to 2 sentences max). Once your answer is complete, return immediately to silent listening.\n` +
        `- Do NOT answer general remarks, ambient chatter, or questions directed at other attendees unless directly summoned.`;
    }

    this.geminiClient = new GeminiLiveClient({
      apiKey: config.geminiApiKey,
      model: config.model,
      voiceName: this.options.voiceName,
      systemInstruction: systemPrompt,
    });

    // Wire Gemini speech back to the browser's synthetic mic
    let lastBotSpeechLog = 0;
    let botSpeakingStartTime = 0;
    this.geminiClient.on('audio', (pcm24kBuffer: Buffer) => {
      // Deterministic Audio Gate for Wake Word Mode
      if (this.isWakeWordMode && !this.isAwake) {
        // Discard audio: bot is in silent standby
        return;
      }

      this.wasapiCapture?.setBotSpeaking(true);
      const now = Date.now();
      if (now - lastBotSpeechLog > 2500) {
        lastBotSpeechLog = now;
        botSpeakingStartTime = now;
        console.log(`🗣️ [${this.options.botName || 'Alex'}]: Speaking response to meeting...`);
        this.emit('status', { state: 'speaking', message: `${this.options.botName || 'Alex'} is speaking...` });
      }
      this.audioBridge?.sendBotAudio(pcm24kBuffer);
    });

    // Full turn conversational accumulators (preserves complete multi-sentence speeches)
    let currentUserTurnText = '';
    let currentBotTurnText = '';
    let userSpeechPauseTimer: NodeJS.Timeout | null = null;

    const flushUserTurn = () => {
      if (userSpeechPauseTimer) {
        clearTimeout(userSpeechPauseTimer);
        userSpeechPauseTimer = null;
      }
      const clean = currentUserTurnText.trim();
      if (clean) {
        console.log(`👤 [Founder / Participant]: "${clean}"`);
        this.transcriptHistory.push({ speaker: 'user', text: clean, timestamp: Date.now() });
        this.emit('transcript', {
          speaker: 'user',
          text: clean,
          isFinal: true,
          timestamp: Date.now(),
        });
      }
      currentUserTurnText = '';
    };

    const flushBotTurn = () => {
      const clean = currentBotTurnText.trim();
      if (clean && !clean.startsWith('**')) {
        console.log(`🤖 [${this.options.botName || 'Alex'}]: "${clean}"`);
        this.transcriptHistory.push({ speaker: 'bot', text: clean, timestamp: Date.now() });
        this.emit('transcript', {
          speaker: 'bot',
          text: clean,
          isFinal: true,
          timestamp: Date.now(),
        });
      }
      currentBotTurnText = '';
    };

    this.geminiClient.on('turnComplete', () => {
      flushBotTurn();
      flushUserTurn();
      this.wasapiCapture?.setBotSpeaking(false);

      if (this.isDeliveringOpeningGreeting) {
        this.isDeliveringOpeningGreeting = false;
        if (this.isWakeWordMode) {
          this.returnToSleep('Opening greeting completed');
        }
      } else if (this.isWakeWordMode && this.isAwake) {
        this.refreshWakeTimeout();
      }
    });

    // Wire Gemini interruption event (human started speaking while bot was talking)
    this.geminiClient.on('interrupted', () => {
      const elapsed = Date.now() - botSpeakingStartTime;
      // Filter out early phantom self-echo interruptions (under 1.2s)
      if (elapsed > 1200) {
        this.audioBridge?.sendInterrupt();
      }
    });

    // Handle user speech transcription recognized by Gemini Live
    this.geminiClient.on('userSpeech', (transcriptChunk: string) => {
      // If the bot was previously speaking, finalize and log its complete turn
      if (currentBotTurnText) {
        flushBotTurn();
      }

      currentUserTurnText += transcriptChunk;

      // Check for wake words in real-time
      if (this.isWakeWordMode && !this.isAwake && this.wakeWordRegex) {
        const match = currentUserTurnText.match(this.wakeWordRegex);
        if (match) {
          this.triggerWake(`Spoken trigger: "${match[0]}"`);
        }
      }

      // Stream incremental token directly to UI in real-time
      this.emit('transcript', {
        speaker: 'user',
        text: transcriptChunk,
        isIncremental: true,
        fullText: currentUserTurnText,
        timestamp: Date.now(),
      });

      const currentStatusMsg = this.isWakeWordMode && !this.isAwake
        ? `Standby (Listening for "${this.wakeWords[0] || 'Hey ' + (this.options.botName || 'Alex')}")`
        : 'Listening to participant...';

      this.emit('status', {
        state: this.isWakeWordMode && !this.isAwake ? 'in_meeting' : 'listening',
        message: currentStatusMsg,
      });

      // If participant pauses speaking and bot is silent (e.g. in standby), flush after natural pause
      if (userSpeechPauseTimer) clearTimeout(userSpeechPauseTimer);
      userSpeechPauseTimer = setTimeout(() => {
        if (currentUserTurnText) {
          flushUserTurn();
        }
      }, 1800);
    });

    // Handle Alex spoken speech transcription recognized by Gemini Live
    this.geminiClient.on('alexSpeech', (textChunk: string) => {
      // In wake-word mode, if bot is currently asleep, drop suppressed text tokens
      if (this.isWakeWordMode && !this.isAwake) {
        return;
      }

      // Participant finished speaking; flush their complete turn immediately
      if (currentUserTurnText) {
        flushUserTurn();
      }

      currentBotTurnText += textChunk;

      // Stream incremental token directly to UI in real-time
      this.emit('transcript', {
        speaker: 'bot',
        text: textChunk,
        isIncremental: true,
        fullText: currentBotTurnText,
        timestamp: Date.now(),
      });
    });

    // Log text turns / internal thoughts
    this.geminiClient.on('text', (text: string) => {
      const trimmed = text.trim();
      if (trimmed.startsWith('**') || trimmed.includes("I'm structuring") || trimmed.includes("I will be") || trimmed.includes("My plan is")) {
        console.log(`💭 [${this.options.botName} Thinking]:\n${trimmed}\n`);
      }
    });

    // Wire captured participant audio directly from Windows WASAPI Loopback to Gemini Live
    this.wasapiCapture = new WasapiCapture();
    this.wasapiCapture.on('audio', (pcm16kChunk: Buffer) => {
      this.geminiClient?.sendAudioChunk(pcm16kChunk);
    });
    this.wasapiCapture.start();

    // Wire captured participant audio from browser bridge (if available)
    this.audioBridge.on('participantAudio', (pcm16kChunk: Buffer) => {
      this.geminiClient?.sendAudioChunk(pcm16kChunk);
    });

    await this.geminiClient.connect();

    // 3. Launch Playwright with persistent profile (saves login session & cookies)
    const chromiumArgs = [
      '--disable-web-security',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream', // Never touches physical webcam hardware
      '--autoplay-policy=no-user-gesture-required',
      '--disable-features=AudioServiceSandbox',
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
    ];

    const isHeadless = this.options.headless === true;
    const userDataDir = path.resolve('./.bot-browser-data');
    console.log(`[MeetingBot] Launching Browser (headless: ${isHeadless}, profile: ${userDataDir})...`);

    const realisticUserAgent =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

    try {
      this.context = await chromium.launchPersistentContext(userDataDir, {
        channel: 'chrome',
        headless: isHeadless,
        ignoreDefaultArgs: ['--enable-automation'],
        args: chromiumArgs,
        permissions: ['microphone', 'camera'],
        viewport: { width: 1280, height: 720 },
        userAgent: realisticUserAgent,
      });
    } catch (err: any) {
      console.warn('[MeetingBot] System Chrome launch failed, falling back to bundled Chromium...');
      this.context = await chromium.launchPersistentContext(userDataDir, {
        headless: isHeadless,
        ignoreDefaultArgs: ['--enable-automation'],
        args: chromiumArgs,
        permissions: ['microphone', 'camera'],
        viewport: { width: 1280, height: 720 },
        userAgent: realisticUserAgent,
      });
    }

    // Add stealth evasion scripts before any page loads
    await this.context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      if (!(window as any).chrome) {
        (window as any).chrome = { runtime: {}, app: {}, csi: () => { }, loadTimes: () => { } };
      }
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      Object.defineProperty(navigator, 'plugins', {
        get: () => [
          { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
        ],
      });
    });

    // Inject our in-browser audio hook before any scripts run
    const hookScript = getInjectAudioHookScript(config.audioBridgePort);
    await this.context.addInitScript(hookScript);

    this.page = this.context.pages()[0] || (await this.context.newPage());
    this.page.on('console', (msg) => {
      const text = msg.text();
      if (text.includes('AudioHook') || text.includes('getUserMedia') || text.includes('AudioBridge')) {
        console.log(`[Browser] ${text}`);
      }
    });

    // Enable CSP bypass on the page session
    try {
      const cdp = await this.context.newCDPSession(this.page);
      await cdp.send('Page.setBypassCSP', { enabled: true });
    } catch (_) { }

    // Determine platform
    const platform =
      this.options.platform === 'auto' || !this.options.platform
        ? this.detectPlatform(this.options.meetingUrl)
        : this.options.platform;

    console.log(`[MeetingBot] Selected meeting platform driver: ${platform.toUpperCase()}`);

    // 4. Execute Platform Driver
    if (platform === 'zoom') {
      const zoomDriver = new ZoomDriver(this.page);
      await zoomDriver.join({
        meetingUrl: this.options.meetingUrl,
        botName: this.options.botName || 'Gurukul AI',
        passcode: this.options.passcode,
      });
    } else if (platform === 'teams') {
      const teamsDriver = new TeamsDriver(this.page);
      await teamsDriver.join({
        meetingUrl: this.options.meetingUrl,
        botName: this.options.botName || 'Gurukul AI',
      });
    } else {
      throw new Error(`Unsupported platform: ${platform}`);
    }

    console.log('[MeetingBot] 🎉 Voice Agent is active in meeting! Listening & responding in real-time.');
    this.emit('status', { state: 'in_meeting', message: `Active in meeting as "${this.options.botName || 'Alex'}"` });

    // Ensure browser AudioContext is running
    await this.page.evaluate(() => {
      const w = window as any;
      if (w.__botAudioCtx && w.__botAudioCtx.state === 'suspended') {
        w.__botAudioCtx.resume().catch(() => { });
      }
    }).catch(() => { });

    // 5. Send entry greeting directive
    if (this.options.greeting && this.options.greeting.trim() !== '') {
      await this.page.waitForTimeout(3000);
      console.log(`[MeetingBot] 🗣️ Introducing ${this.options.botName || 'Alex'} in meeting using voice "${this.options.voiceName || config.botVoice}"...`);
      if (this.isWakeWordMode) {
        this.isDeliveringOpeningGreeting = true;
        this.isAwake = true; // Open gate strictly for greeting delivery
      }
      const greetingPrompt =
        `[System directive: Start the conversation right now by speaking the following greeting with genuine human warmth and friendliness: "${this.options.greeting}"]`;
      this.geminiClient.sendText(greetingPrompt);
    } else if (this.isWakeWordMode) {
      const primaryTrigger = this.wakeWords[0] || `Hey ${this.options.botName || 'Alex'}`;
      this.emit('status', {
        state: 'in_meeting',
        message: `Standby (Waiting for "${primaryTrigger}")`,
      });
      this.emit('log', { message: `Standby Mode Active. Call upon the bot with: "${primaryTrigger}"`, level: 'info' });
    }
  }

  /**
   * Manually or automatically triggers the bot out of sleep into active listening & responding state.
   */
  public triggerWake(reason: string = 'Triggered'): void {
    const wasAwake = this.isAwake;
    this.isAwake = true;

    if (!wasAwake) {
      console.log(`⚡ [MeetingBot] WAKE TRIGGER (${reason})! Bot audio gate is now OPEN.`);
      this.emit('status', { state: 'awake', message: `⚡ ${this.options.botName || 'Alex'} is active & responding!` });
      this.emit('log', { message: `⚡ Bot awakened: ${reason}`, level: 'success' });
    }

    this.refreshWakeTimeout();
  }

  private refreshWakeTimeout(): void {
    if (this.wakeTimeoutTimer) {
      clearTimeout(this.wakeTimeoutTimer);
    }
    this.wakeTimeoutTimer = setTimeout(() => {
      this.returnToSleep();
    }, this.wakeTimeoutSeconds * 1000);
  }

  /**
   * Returns bot to silent standby mode, dropping outgoing audio unless called upon again.
   */
  public returnToSleep(reason: string = 'Active window expired'): void {
    if (this.wakeTimeoutTimer) {
      clearTimeout(this.wakeTimeoutTimer);
      this.wakeTimeoutTimer = null;
    }
    if (this.isAwake && this.isWakeWordMode) {
      this.isAwake = false;
      const primaryTrigger = this.wakeWords[0] || `Hey ${this.options.botName || 'Alex'}`;
      console.log(`💤 [MeetingBot] ${reason}. Returning to silent standby (Waiting for "${primaryTrigger}").`);
      this.emit('status', {
        state: 'in_meeting',
        message: `Standby (Waiting for "${primaryTrigger}")`,
      });
      this.emit('log', { message: `💤 Bot returned to silent standby: ${reason}`, level: 'info' });
    }
  }

  public getIsAwake(): boolean {
    return this.isAwake;
  }

  /**
   * Shuts down all processes and closes connections cleanly.
   */
  public async stop(): Promise<void> {
    if (!this.isRunning) return;
    this.isRunning = false;

    if (this.wakeTimeoutTimer) {
      clearTimeout(this.wakeTimeoutTimer);
      this.wakeTimeoutTimer = null;
    }

    console.log('[MeetingBot] 🛑 Stopping Meeting Voice Agent...');

    try {
      if (this.geminiClient) {
        this.geminiClient.disconnect();
        this.geminiClient = null;
      }

      if (this.wasapiCapture) {
        this.wasapiCapture.stop();
        this.wasapiCapture = null;
      }

      if (this.audioBridge) {
        await this.audioBridge.stop();
        this.audioBridge = null;
      }

      if (this.page) {
        await this.page.close().catch(() => { });
        this.page = null;
      }

      if (this.context) {
        await this.context.close().catch(() => { });
        this.context = null;
      }

      if (this.browser) {
        await this.browser.close().catch(() => { });
        this.browser = null;
      }
    } finally {
      this.isRunning = false;
      console.log('[MeetingBot] ✅ All resources cleaned up.');
      this.emit('status', { state: 'idle', message: 'Meeting session terminated' });
      this.emit('stopped');
    }
  }

  public getIsRunning(): boolean {
    return this.isRunning;
  }

  public getTranscriptHistory(): Array<{ speaker: 'user' | 'bot'; text: string; timestamp: number }> {
    return [...this.transcriptHistory];
  }

  public getSessionDurationSeconds(): number {
    if (!this.meetingStartTime) return 0;
    return Math.floor((Date.now() - this.meetingStartTime) / 1000);
  }
}
