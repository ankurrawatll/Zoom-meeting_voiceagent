import { WebSocketServer, WebSocket } from 'ws';
import { EventEmitter } from 'events';
import { downsample48kTo16k, resamplePcm16 } from './resampler.js';

export interface AudioBridgeOptions {
  port?: number;
  host?: string;
}

export class AudioBridge extends EventEmitter {
  private wss: WebSocketServer | null = null;
  private browserWs: WebSocket | null = null;
  private port: number;
  private host: string;
  private isListening = false;
  private lastSpeechLogTime = 0;
  private lastBotAudioSendTime = 0;

  constructor(options: AudioBridgeOptions = {}) {
    super();
    this.port = options.port || 8765;
    this.host = options.host || '127.0.0.1';
  }

  /**
   * Starts the WebSocket server for in-browser audio communication.
   */
  public async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.wss = new WebSocketServer({ port: this.port, host: this.host });

        this.wss.on('listening', () => {
          this.isListening = true;
          console.log(`[AudioBridge] 🎧 Audio bridge WebSocket server listening on ws://${this.host}:${this.port}`);
          resolve();
        });

        this.wss.on('connection', (ws: WebSocket) => {
          console.log('[AudioBridge] 🔗 In-browser audio hook connected.');
          this.browserWs = ws;
          this.emit('browserConnected');

          ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
            try {
              // Suppress meeting audio while the bot is outputting speech to prevent room echo self-interruptions
              if (Date.now() - this.lastBotAudioSendTime < 600) {
                return;
              }

              if (Buffer.isBuffer(data) && data.length > 4) {
                // Read sample rate header (Uint32 LE, 4 bytes)
                const sourceRate = data.readUInt32LE(0);
                const pcmRaw = data.subarray(4);

                // Resample to 16kHz for Gemini Live (direct pass-through if browser already downsampled via Chromium Web Audio)
                const pcm16k =
                  sourceRate === 16000
                    ? pcmRaw
                    : sourceRate === 48000
                    ? downsample48kTo16k(pcmRaw)
                    : resamplePcm16(pcmRaw, sourceRate || 48000, 16000);

                // Calculate RMS energy to detect participant speech
                let sumSq = 0;
                const sampleCount = pcm16k.length / 2;
                for (let i = 0; i < sampleCount; i++) {
                  const s = pcm16k.readInt16LE(i * 2) / 32768.0;
                  sumSq += s * s;
                }
                const rms = Math.sqrt(sumSq / sampleCount);

                const now = Date.now();
                if (rms > 0.035 && now - this.lastSpeechLogTime > 2000) {
                  this.lastSpeechLogTime = now;
                  console.log(`👂 [Meeting Audio] Hearing participant speech (${(rms * 100).toFixed(1)}% volume). Sending to Gemini Live...`);
                }

                this.emit('participantAudio', pcm16k);
              } else if (typeof data === 'string' || (data instanceof Buffer && data.length < 512)) {
                // JSON control message
                const msg = JSON.parse(data.toString());
                this.emit('control', msg);
              }
            } catch (err: any) {
              console.error('[AudioBridge] Error processing message from browser:', err.message);
            }
          });

          ws.on('close', () => {
            console.log('[AudioBridge] 🔌 Browser audio hook disconnected.');
            if (this.browserWs === ws) {
              this.browserWs = null;
            }
            this.emit('browserDisconnected');
          });

          ws.on('error', (err) => {
            console.error('[AudioBridge] Browser WebSocket error:', err.message);
          });
        });

        this.wss.on('error', (err) => {
          console.error('[AudioBridge] WebSocket Server error:', err);
          reject(err);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Sends 24kHz raw PCM audio from Gemini Live to the browser synthetic microphone.
   */
  public sendBotAudio(pcm24kBuffer: Buffer): void {
    if (!this.browserWs || this.browserWs.readyState !== WebSocket.OPEN) {
      return;
    }
    this.lastBotAudioSendTime = Date.now();
    // We send raw binary buffer directly
    this.browserWs.send(pcm24kBuffer);
  }

  /**
   * Tells the browser to immediately interrupt and cancel queued audio playback.
   */
  public sendInterrupt(): void {
    if (!this.browserWs || this.browserWs.readyState !== WebSocket.OPEN) {
      return;
    }
    const interruptMsg = JSON.stringify({ type: 'interrupt' });
    this.browserWs.send(interruptMsg);
  }

  /**
   * Checks if browser is currently connected.
   */
  public isConnected(): boolean {
    return this.browserWs !== null && this.browserWs.readyState === WebSocket.OPEN;
  }

  /**
   * Stops the Audio Bridge server.
   */
  public stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.browserWs) {
        try { this.browserWs.close(); } catch (_) {}
        this.browserWs = null;
      }
      if (this.wss) {
        this.wss.close(() => {
          this.isListening = false;
          console.log('[AudioBridge] Audio bridge stopped.');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}
