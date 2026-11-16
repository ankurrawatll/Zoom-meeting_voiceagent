import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { MeetingBot } from './bot/meetingBot.js';
import { GeminiLiveClient } from './ai/geminiLiveClient.js';
import { PERSONA_PRESETS } from './web/presets.js';
import { config, validateConfig } from './config/env.js';
import { analyzeMeeting, MeetingAnalysis } from './ai/meetingAnalyzer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env.STUDIO_PORT || process.env.UI_PORT || '3050', 10);
const PUBLIC_DIR = path.resolve(__dirname, 'web/public');

// Active Bot Session State
let currentBot: MeetingBot | null = null;
let activeSession: {
  meetingUrl: string;
  botName: string;
  voiceName: string;
  headless: boolean;
  platform: string;
  startTime: number;
} | null = null;

// Post-meeting Pitch Analysis & Scoring State
let lastMeetingAnalysis: MeetingAnalysis | null = null;
let lastMeetingTranscripts: any[] = [];
let isAnalyzingMeeting = false;

const wsClients = new Set<WebSocket>();
const previewAudioCache = new Map<string, Buffer>();

/**
 * Encodes 24kHz 16-bit mono raw PCM samples into standard 44-byte header WAV buffer.
 */
function pcmToWav(pcmBuffer: Buffer, sampleRate = 24000, numChannels = 1, bitsPerSample = 16): Buffer {
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = pcmBuffer.length;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmBuffer]);
}

/**
 * Synthesizes a fast 2-3 second voice sample directly from Gemini Live API for live browser preview.
 */
async function generateVoicePreviewWav(voiceName: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    validateConfig();
    if (!config.geminiApiKey) {
      return reject(new Error('GEMINI_API_KEY is not configured in environment.'));
    }

    const client = new GeminiLiveClient({
      apiKey: config.geminiApiKey,
      model: config.model,
      voiceName: voiceName,
      systemInstruction: `You are demonstrating your voice in a test. Say naturally: "Hello! This is a preview of the ${voiceName} voice on AI-agent."`,
    });

    const audioChunks: Buffer[] = [];
    let isDone = false;
    let timeout: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      client.disconnect();
    };

    timeout = setTimeout(() => {
      if (isDone) return;
      isDone = true;
      cleanup();
      if (audioChunks.length > 0) {
        resolve(pcmToWav(Buffer.concat(audioChunks), 24000));
      } else {
        reject(new Error(`Voice preview timed out for "${voiceName}"`));
      }
    }, 7500);

    client.on('audio', (chunk: Buffer) => {
      audioChunks.push(chunk);
    });

    client.on('turnComplete', () => {
      if (isDone) return;
      isDone = true;
      cleanup();
      if (audioChunks.length > 0) {
        resolve(pcmToWav(Buffer.concat(audioChunks), 24000));
      } else {
        reject(new Error(`Empty audio received for voice "${voiceName}"`));
      }
    });

    client.on('error', (err) => {
      if (isDone) return;
      isDone = true;
      cleanup();
      reject(err);
    });

    client.connect()
      .then(() => {
        client.sendText(`Introduce your voice in one short sentence: "Hello! This is the ${voiceName} voice on AI-agent."`);
      })
      .catch((err) => {
        if (isDone) return;
        isDone = true;
        cleanup();
        reject(err);
      });
  });
}

function broadcast(payload: { type: string; data?: any }) {
  const json = JSON.stringify(payload);
  for (const client of wsClients) {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(json);
      } catch (err) {
        console.error('[Server] Error broadcasting to client:', err);
      }
    }
  }
}

async function runPostMeetingAnalysis(history: any[], botName: string, duration: number) {
  if (isAnalyzingMeeting) return;
  lastMeetingTranscripts = history;
  isAnalyzingMeeting = true;
  broadcast({
    type: 'analysis_status',
    data: {
      state: 'analyzing',
      message: 'Analyzing meeting pitch, computing metric scores, validation info & executive summary...',
    },
  });

  try {
    console.log(`[Server] 📊 Initiating post-meeting analysis on ${history.length} dialogue turns...`);
    const analysis = await analyzeMeeting(history, botName, duration);
    lastMeetingAnalysis = analysis;
    console.log(`[Server] ✅ Meeting analysis complete! Score: ${analysis.overallScore}/100 (${analysis.ratingBadge})`);
    broadcast({ type: 'analysis_complete', data: analysis });
  } catch (err: any) {
    console.error('[Server] Failed to generate meeting analysis:', err);
    broadcast({
      type: 'analysis_status',
      data: { state: 'error', message: err.message || 'Analysis failed' },
    });
  } finally {
    isAnalyzingMeeting = false;
  }
}

// HTTP Server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // 1. GET /api/presets
  if (req.method === 'GET' && url.pathname === '/api/presets') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(PERSONA_PRESETS));
    return;
  }

  // 2. GET /api/status
  if (req.method === 'GET' && url.pathname === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        isRunning: !!currentBot && currentBot.getIsRunning(),
        session: activeSession,
      })
    );
    return;
  }

  // 3. GET /api/voice/preview?voice=Kore
  if (req.method === 'GET' && url.pathname === '/api/voice/preview') {
    const requestedVoice = url.searchParams.get('voice') || config.botVoice || 'Puck';

    // Return cached audio if already generated
    if (previewAudioCache.has(requestedVoice)) {
      const wav = previewAudioCache.get(requestedVoice)!;
      res.writeHead(200, {
        'Content-Type': 'audio/wav',
        'Content-Length': wav.length,
        'Cache-Control': 'public, max-age=86400',
      });
      res.end(wav);
      return;
    }

    try {
      console.log(`🎙️ [Server] Generating real-time audio preview for voice: "${requestedVoice}"...`);
      const wav = await generateVoicePreviewWav(requestedVoice);
      previewAudioCache.set(requestedVoice, wav);
      res.writeHead(200, {
        'Content-Type': 'audio/wav',
        'Content-Length': wav.length,
        'Cache-Control': 'public, max-age=86400',
      });
      res.end(wav);
    } catch (err: any) {
      console.error(`[Server] Voice preview failed for "${requestedVoice}":`, err.message || err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || 'Failed to generate voice preview' }));
    }
    return;
  }

  // 4. POST /api/session/start
  if (req.method === 'POST' && url.pathname === '/api/session/start') {
    if (currentBot && currentBot.getIsRunning()) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'A meeting session is already active. Stop the current session first.' }));
      return;
    }

    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const {
          meetingUrl,
          botName,
          voiceName,
          headless,
          systemPrompt,
          greeting,
          interactionMode,
          wakeWords,
          wakeTimeoutSeconds,
        } = payload;

        if (!meetingUrl || typeof meetingUrl !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Meeting URL is required' }));
          return;
        }

        validateConfig();

        const selectedVoice = voiceName && typeof voiceName === 'string' && voiceName.trim() !== ''
          ? voiceName.trim()
          : config.botVoice;
        const selectedBotName = botName && typeof botName === 'string' && botName.trim() !== ''
          ? botName.trim()
          : config.botName;
        const selectedMode: 'continuous' | 'wake_word' = interactionMode === 'wake_word' ? 'wake_word' : 'continuous';

        const parsedWakeWords: string[] | undefined = Array.isArray(wakeWords)
          ? wakeWords
          : (typeof wakeWords === 'string' && wakeWords.trim()
            ? wakeWords.split(',').map((w: string) => w.trim()).filter(Boolean)
            : undefined);
        const parsedWakeTimeout = typeof wakeTimeoutSeconds === 'number' && wakeTimeoutSeconds > 0
          ? wakeTimeoutSeconds
          : 15;

        console.log('====================================================');
        console.log(`🤖 [Server] Starting AI-agent: "${selectedBotName}"`);
        console.log(`🎙️ [Server] Selected Gemini Voice: "${selectedVoice}"`);
        console.log(`⚙️ [Server] Response Mode: "${selectedMode.toUpperCase()}"` + (selectedMode === 'wake_word' ? ` (Triggers: ${parsedWakeWords?.join(', ') || 'Hey Alex'})` : ''));
        console.log(`🔗 [Server] Meeting Link: ${meetingUrl.trim()}`);
        console.log('====================================================');

        const bot = new MeetingBot({
          meetingUrl: meetingUrl.trim(),
          botName: selectedBotName,
          voiceName: selectedVoice,
          headless: headless !== undefined ? Boolean(headless) : config.headless,
          systemPrompt: systemPrompt || undefined,
          greeting: greeting !== undefined ? greeting : undefined,
          interactionMode: selectedMode,
          wakeWords: parsedWakeWords,
          wakeTimeoutSeconds: parsedWakeTimeout,
        });

        currentBot = bot;
        activeSession = {
          meetingUrl: meetingUrl.trim(),
          botName: selectedBotName,
          voiceName: selectedVoice,
          headless: headless !== undefined ? Boolean(headless) : config.headless,
          platform: bot.detectPlatform(meetingUrl.trim()),
          startTime: Date.now(),
        };

        // Forward MeetingBot events to all connected WebSocket clients
        bot.on('status', (data) => broadcast({ type: 'status', data }));
        bot.on('transcript', (data) => broadcast({ type: 'transcript', data }));
        bot.on('log', (data) => broadcast({ type: 'log', data }));
        bot.on('stopped', () => {
          if (currentBot) {
            const history = currentBot.getTranscriptHistory();
            const duration = currentBot.getSessionDurationSeconds();
            const bName = activeSession?.botName || 'Alex (Investor)';
            runPostMeetingAnalysis(history, bName, duration);
          }
          currentBot = null;
          activeSession = null;
          broadcast({ type: 'stopped' });
        });

        // Respond immediately to prevent HTTP timeouts while bot automates browser
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Session starting' }));

        // Start the bot asynchronously in background
        bot.start().catch((err: any) => {
          console.error('[Server] Bot execution error:', err);
          broadcast({
            type: 'log',
            data: { message: `Bot stopped with error: ${err.message}`, level: 'error' },
          });
          currentBot = null;
          activeSession = null;
          broadcast({ type: 'stopped' });
        });
      } catch (err: any) {
        console.error('[Server] Failed to parse request body:', err);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
      }
    });
    return;
  }

  // 5. POST /api/session/stop
  if (req.method === 'POST' && url.pathname === '/api/session/stop') {
    if (!currentBot) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'No active session running' }));
      return;
    }

    try {
      const bot = currentBot;
      const history = bot.getTranscriptHistory();
      const duration = bot.getSessionDurationSeconds();
      const bName = activeSession?.botName || 'Alex (Investor)';

      currentBot = null;
      activeSession = null;
      await bot.stop();
      broadcast({ type: 'stopped' });

      // Run post-meeting pitch evaluation & scoring
      runPostMeetingAnalysis(history, bName, duration);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'Session stopped successfully, analysis underway' }));
    } catch (err: any) {
      console.error('[Server] Error stopping session:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Error stopping session: ${err.message}` }));
    }
    return;
  }

  // 6. POST /api/session/wake (Manually summon / wake bot from dashboard)
  if (req.method === 'POST' && url.pathname === '/api/session/wake') {
    if (!currentBot || !currentBot.getIsRunning()) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No active session running to wake up' }));
      return;
    }

    currentBot.triggerWake('Manual UI Summon');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, message: 'Bot awakened successfully' }));
    return;
  }

  // 7. GET /api/session/analysis (Fetch last meeting scorecard & evaluation)
  if (req.method === 'GET' && url.pathname === '/api/session/analysis') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      analysis: lastMeetingAnalysis,
      isAnalyzing: isAnalyzingMeeting,
    }));
    return;
  }

  // 8. POST /api/session/analysis/reanalyze (Re-run analysis on last meeting)
  if (req.method === 'POST' && url.pathname === '/api/session/analysis/reanalyze') {
    if (lastMeetingTranscripts.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No previous meeting transcripts available to re-analyze' }));
      return;
    }
    runPostMeetingAnalysis(lastMeetingTranscripts, 'Alex (Investor)', 0);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, message: 'Re-analysis triggered' }));
    return;
  }

  // 7. Static Files Serving (src/web/public/index.html)
  let filePath = path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname);

  // Security check: keep within PUBLIC_DIR
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // Fallback to index.html for SPA routes
      filePath = path.join(PUBLIC_DIR, 'index.html');
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
    };

    const contentType = mimeTypes[ext] || 'application/octet-stream';

    fs.readFile(filePath, (readErr, content) => {
      if (readErr) {
        res.writeHead(500);
        res.end('Error reading file');
        return;
      }
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    });
  });
});

// WebSocket Server on /ws
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  wsClients.add(ws);

  // Send initial state to newly connected client
  ws.send(
    JSON.stringify({
      type: 'init',
      data: {
        isRunning: !!currentBot && currentBot.getIsRunning(),
        session: activeSession,
        lastAnalysis: lastMeetingAnalysis,
        isAnalyzing: isAnalyzingMeeting,
      },
    })
  );

  ws.on('close', () => {
    wsClients.delete(ws);
  });
});

// Graceful Shutdown
async function handleShutdown() {
  console.log('\n[Server] Shutting down AI-agent Studio Server...');
  if (currentBot) {
    try {
      await currentBot.stop();
    } catch (e) { }
    currentBot = null;
  }
  wss.close();
  server.close(() => {
    console.log('[Server] Studio server closed.');
    process.exit(0);
  });
}

process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);

// Start listening
server.listen(PORT, () => {
  console.log('====================================================');
  console.log('🎙️  AI-agent Meeting Studio Dashboard');
  console.log(`🌐 Studio UI: http://localhost:${PORT}`);
  console.log('====================================================');
});
