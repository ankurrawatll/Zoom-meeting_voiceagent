import { MeetingBot, MeetingPlatform } from './bot/meetingBot.js';
import { config } from './config/env.js';

function parseArgs(): {
  meetingUrl?: string;
  platform?: MeetingPlatform;
  botName?: string;
  passcode?: string;
  voiceName?: string;
  headless?: boolean;
  systemPrompt?: string;
  greeting?: string;
  ui?: boolean;
  help?: boolean;
} {
  const args = process.argv.slice(2);
  const options: Record<string, any> = {
    greeting: "Hey there! Thanks for hopping on the call. I'm excited to hear about what you're building. Whenever you're ready, dive in with the pitch!",
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--url' || arg === '-u') {
      options.meetingUrl = args[++i];
    } else if (arg === '--platform' || arg === '-p') {
      options.platform = args[++i] as MeetingPlatform;
    } else if (arg === '--name' || arg === '-n') {
      options.botName = args[++i];
    } else if (arg === '--passcode') {
      options.passcode = args[++i];
    } else if (arg === '--voice' || arg === '-v') {
      options.voiceName = args[++i];
    } else if (arg === '--headless') {
      const val = args[++i];
      options.headless = val !== 'false';
    } else if (arg === '--prompt') {
      options.systemPrompt = args[++i];
    } else if (arg === '--greeting' || arg === '-g') {
      options.greeting = args[++i];
    } else if (arg === '--no-greeting') {
      options.greeting = '';
    } else if (arg === '--ui') {
      options.ui = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    }
  }

  return options;
}

function printUsage(): void {
  console.log(`
======================================================================
  🎙️  AI-agent Meeting Studio (Zoom & Microsoft Teams)
======================================================================

Usage:
  npm run ui                               Launch Web Control Studio (Recommended)
  npx tsx src/index.ts                     Launch Web Control Studio
  npx tsx src/index.ts --url <MEETING_URL> [options]  Run directly in CLI

Options:
  --url, -u       Meeting invite URL (Zoom or Microsoft Teams)
  --ui            Launch Web UI Control Studio
  --platform, -p  Target platform ('zoom', 'teams', or 'auto' [default])
  --name, -n      Display name of the bot (default: "${config.botName}")
  --passcode      Meeting passcode (if not in URL)
  --voice, -v     Gemini voice name: Puck, Charon, Kore, Fenrir, Aoede (default: "${config.botVoice}")
  --headless      Run browser in headless mode: true/false (default: ${config.headless})
  --greeting, -g  Initial greeting sentence upon entering meeting (or --no-greeting)
  --prompt        Custom system instruction for Gemini Live
  --help, -h      Show this help message

Examples:
  # Launch the Web Control Studio UI:
  npm run ui

  # Join Zoom pitch meeting as Virtual Investor:
  npx tsx src/index.ts --url "https://zoom.us/j/1234567890?pwd=xyz" --name "Alex (Investor)"

======================================================================
`);
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (args.help) {
    printUsage();
    process.exit(0);
  }

  // If no URL provided or --ui flag passed, launch the Web Control Studio
  if (!args.meetingUrl || args.ui) {
    console.log('🚀 Launching AI-agent Web Control Studio...\n');
    await import('./server.js');
    return;
  }

  const bot = new MeetingBot({
    meetingUrl: args.meetingUrl,
    platform: args.platform,
    botName: args.botName,
    passcode: args.passcode,
    voiceName: args.voiceName,
    headless: args.headless,
    systemPrompt: args.systemPrompt,
    greeting: args.greeting,
  });

  // Handle Ctrl+C and termination gracefully
  const shutdown = async () => {
    console.log('\n[Main] Received exit signal. Shutting down gracefully...');
    await bot.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await bot.start();

    // Keep process alive while meeting is running
    console.log('[Main] Voice Agent is running. Press Ctrl+C to disconnect and exit.');
  } catch (err: any) {
    console.error('❌ Failed to start Voice Agent:', err.message || err);
    await bot.stop();
    process.exit(1);
  }
}

main();
