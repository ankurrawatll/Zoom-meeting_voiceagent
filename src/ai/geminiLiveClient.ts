import { WebSocket } from 'ws';
import { EventEmitter } from 'events';

export interface GeminiLiveClientOptions {
  apiKey: string;
  model?: string;
  voiceName?: string;
  systemInstruction?: string;
}

export class GeminiLiveClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private apiKey: string;
  private model: string;
  private voiceName: string;
  private systemInstruction: string;
  private isConnected = false;
  private isSetupComplete = false;
  private pendingAudioChunks: Buffer[] = [];

  constructor(options: GeminiLiveClientOptions) {
    super();
    this.apiKey = options.apiKey;
    this.model = options.model || 'models/gemini-2.5-flash-native-audio-preview-12-2025';
    this.voiceName = options.voiceName || 'Puck';
    this.systemInstruction = options.systemInstruction ||
      'You are an experienced, sharp, and curious Venture Capital & Angel Investor participating in a pitch and strategy discussion with a startup founder. ' +
      'Your goal is to evaluate the startup, ask insightful, probing questions about their product, traction, target market (TAM), unit economics, customer acquisition (CAC), retention, and defensible moat. ' +
      'Provide candid, constructive feedback and ask relevant follow-up questions just like a seasoned tech investor. ' +
      'Keep your responses spoken naturally, conversational, and concise (1 to 3 sentences maximum per turn) so the founder can pitch and dialogue interactively without monologues.';
  }

  public async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${this.apiKey}`;
      console.log(`[GeminiLive] Connecting to Gemini Live API (${this.model}) with Voice: "${this.voiceName}"...`);

      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        console.log('[GeminiLive] ✅ WebSocket connection opened. Sending setup handshake...');
        this.isConnected = true;
        this.sendSetup();
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        try {
          const str = data.toString();
          const msg = JSON.parse(str);
          this.handleServerMessage(msg);

          if (msg.setupComplete && !this.isSetupComplete) {
            this.isSetupComplete = true;
            console.log('[GeminiLive] ✅ Setup handshake completed. Ready for real-time audio.');
            this.flushPendingAudio();
            resolve();
          }
        } catch (err: any) {
          console.error('[GeminiLive] ❌ Error parsing message from Gemini:', err.message || err);
        }
      });

      this.ws.on('error', (err) => {
        console.error('[GeminiLive] ❌ WebSocket error:', err.message || err);
        this.emit('error', err);
        if (!this.isSetupComplete) reject(err);
      });

      this.ws.on('close', (code, reason) => {
        console.log(`[GeminiLive] 🔌 Connection closed (code: ${code}, reason: ${reason.toString() || 'none'})`);
        this.isConnected = false;
        this.isSetupComplete = false;
        this.emit('close', { code, reason: reason.toString() });
      });
    });
  }

  private sendSetup(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    console.log(`[GeminiLive] 🗣️ Sending setup payload with Voice: "${this.voiceName}" (PrebuiltVoiceConfig)`);

    const setupPayload = {
      setup: {
        model: this.model,
        generationConfig: {
          responseModalities: ['AUDIO'],
          temperature: 0.7,
          thinkingConfig: {
            thinkingBudget: 0,
          },
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: this.voiceName,
              },
            },
          },
        },
        inputAudioTranscription: {
          languageCodes: ['en-US'],
        },
        outputAudioTranscription: {},
        realtimeInputConfig: {
          activityHandling: 'START_OF_ACTIVITY_INTERRUPTS',
          automaticActivityDetection: {
            disabled: false,
            prefixPaddingMs: 150,
            silenceDurationMs: 650,
          },
        },
        systemInstruction: {
          parts: [
            {
              text: this.systemInstruction,
            },
          ],
        },
      },
    };

    this.ws.send(JSON.stringify(setupPayload));
  }

  private handleServerMessage(msg: any): void {
    if (msg.error) {
      console.error('❌ [GeminiLive API Error]:', JSON.stringify(msg.error));
      return;
    }

    // 1. User input speech transcription
    const userText = msg.serverContent?.inputTranscription?.text || msg.serverContent?.inputAudioTranscription?.text;
    if (userText) {
      this.emit('userSpeech', userText);
    }

    // 2. Alex output speech transcription (Google sends outputTranscription.text)
    const alexText = msg.serverContent?.outputTranscription?.text || msg.serverContent?.outputAudioTranscription?.text;
    if (alexText) {
      this.emit('alexSpeech', alexText);
    }

    // 3. Audio and Text response parts
    if (msg.serverContent?.modelTurn?.parts) {
      for (const part of msg.serverContent.modelTurn.parts) {
        if (part.inlineData && part.inlineData.mimeType?.startsWith('audio/pcm')) {
          const base64Data = part.inlineData.data;
          const pcm24kBuffer = Buffer.from(base64Data, 'base64');
          // Emit 24kHz raw PCM chunk
          this.emit('audio', pcm24kBuffer);
        }
        if (part.text) {
          this.emit('text', part.text);
          // If server didn't emit outputTranscription separately, also stream conversational part.text
          if (!alexText && !part.text.startsWith('**') && !part.text.includes("I'm structuring") && !part.text.includes("I will be") && !part.text.includes("My plan is")) {
            this.emit('alexSpeech', part.text);
          }
        }
      }
    }

    // 3. Interruption event (human spoke while bot was talking)
    if (msg.serverContent?.interrupted) {
      console.log('⚡ [GeminiLive] User interrupted bot speech!');
      this.emit('interrupted');
    }

    // 4. Turn complete
    if (msg.serverContent?.turnComplete) {
      this.emit('turnComplete');
    }
  }

  /**
   * Streams raw 16kHz 16-bit Mono Linear PCM audio from meeting participants to Gemini Live.
   * Direct zero-latency dispatch without artificial timer or queue delays.
   */
  public sendAudioChunk(pcm16kBuffer: Buffer): void {
    if (!this.isSetupComplete || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.pendingAudioChunks.push(pcm16kBuffer);
      if (this.pendingAudioChunks.length > 30) this.pendingAudioChunks.shift(); // Bound memory
      return;
    }

    const base64Audio = pcm16kBuffer.toString('base64');
    const audioPayload = {
      realtimeInput: {
        mediaChunks: [
          {
            mimeType: 'audio/pcm;rate=16000',
            data: base64Audio,
          },
        ],
      },
    };

    try {
      this.ws.send(JSON.stringify(audioPayload));
    } catch (err: any) {
      console.error('[GeminiLive] Error streaming audio chunk:', err.message || err);
    }
  }

  /**
   * Sends a text turn to Gemini Live (e.g. for greetings or instructions).
   */
  public sendText(text: string): void {
    if (!this.isSetupComplete || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[GeminiLive] Cannot send text: setup not complete');
      return;
    }

    const payload = {
      clientContent: {
        turns: [
          {
            role: 'user',
            parts: [{ text }],
          },
        ],
        turnComplete: true,
      },
    };

    this.ws.send(JSON.stringify(payload));
  }

  private flushPendingAudio(): void {
    while (this.pendingAudioChunks.length > 0) {
      const chunk = this.pendingAudioChunks.shift();
      if (chunk) this.sendAudioChunk(chunk);
    }
  }

  public disconnect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      this.ws.close();
    }
    this.isConnected = false;
    this.isSetupComplete = false;
  }
}
