import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class WasapiCapture extends EventEmitter {
  private proc: ChildProcess | null = null;
  private isCapturing = false;
  private lastSpeechLogTime = 0;
  private isBotSpeaking = false;
  private botSpeakingHoldUntil = 0;

  constructor() {
    super();
  }

  /**
   * Sets whether the bot is currently playing speech.
   * While true (plus a 500ms safety decay), incoming audio is suppressed
   * to eliminate local acoustic echo and self-interruption.
   */
  public setBotSpeaking(speaking: boolean): void {
    this.isBotSpeaking = speaking;
    if (speaking) {
      this.botSpeakingHoldUntil = Date.now() + 500;
    }
  }

  /**
   * Starts the Windows WASAPI Loopback capture process.
   */
  public start(): void {
    if (this.isCapturing) return;
    this.isCapturing = true;

    const pythonPath = 'C:\\Program Files\\Python311\\python.exe';
    const scriptPath = path.join(__dirname, 'wasapiLoopback.py');

    console.log(`[WasapiCapture] 🎙️ Initializing Windows WASAPI Loopback Audio Capture...`);

    this.proc = spawn(pythonPath, ['-u', scriptPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.proc.stdout?.on('data', (chunk: Buffer) => {
      // Acoustic echo suppression: drop frames if the bot is speaking or recently finished
      if (this.isBotSpeaking || Date.now() < this.botSpeakingHoldUntil) {
        return;
      }

      // Calculate RMS volume level of this 16kHz PCM chunk
      let sumSq = 0;
      const sampleCount = Math.floor(chunk.length / 2);
      for (let i = 0; i < sampleCount; i++) {
        const s = chunk.readInt16LE(i * 2) / 32768.0;
        sumSq += s * s;
      }
      const rms = Math.sqrt(sumSq / sampleCount);

      const now = Date.now();
      if (rms > 0.035 && now - this.lastSpeechLogTime > 2000) {
        this.lastSpeechLogTime = now;
        console.log(`👂 [Meeting Audio] Hearing participant speech (${(rms * 100).toFixed(1)}% volume). Streaming to Gemini Live...`);
      }

      this.emit('audio', chunk);
    });

    this.proc.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString('utf-8').trim();
      if (msg) {
        console.log(msg);
      }
    });

    this.proc.on('close', (code) => {
      this.isCapturing = false;
      this.proc = null;
      if (code !== 0 && code !== null) {
        console.log(`[WasapiCapture] Loopback capture process ended (code: ${code})`);
      }
    });

    this.proc.on('error', (err) => {
      console.error('[WasapiCapture Error]:', err);
    });
  }

  /**
   * Stops the capture process cleanly.
   */
  public stop(): void {
    if (this.proc) {
      try {
        this.proc.kill('SIGTERM');
      } catch (_) {}
      this.proc = null;
    }
    this.isCapturing = false;
  }
}

