import { GeminiLiveClient } from '../src/ai/geminiLiveClient.js';
import { config, validateConfig } from '../src/config/env.js';

/**
 * Creates a synthetic 16kHz 16-bit mono PCM sine wave buffer.
 */
function generateTestPcmSineWave(durationSeconds: number = 1.0, freqHz: number = 440): Buffer {
  const sampleRate = 16000;
  const numSamples = Math.floor(sampleRate * durationSeconds);
  const buffer = Buffer.alloc(numSamples * 2);

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const sample = Math.sin(2 * Math.PI * freqHz * t) * 0.25; // Gentle volume
    const int16Val = Math.floor(sample * 32767);
    buffer.writeInt16LE(int16Val, i * 2);
  }

  return buffer;
}

async function testGeminiLive(): Promise<void> {
  console.log('--- 🧪 Testing Gemini Live S2S Connection ---');
  validateConfig();

  if (!config.geminiApiKey) {
    console.error('❌ Cannot run test: GEMINI_API_KEY is not configured.');
    process.exit(1);
  }

  console.log(`Using API Key: ${config.geminiApiKey.substring(0, 8)}... (${config.geminiApiKey.length} chars)`);
  console.log(`Model: ${config.model}`);
  console.log(`Voice: ${config.botVoice}`);

  const client = new GeminiLiveClient({
    apiKey: config.geminiApiKey,
    model: config.model,
    voiceName: config.botVoice,
    systemInstruction: 'You are Gurukul AI in test mode. Acknowledge this audio signal briefly in one sentence.',
  });

  let audioPacketsReceived = 0;
  let totalBytesReceived = 0;
  let textReceived = '';

  client.on('audio', (pcm24kBuffer: Buffer) => {
    audioPacketsReceived++;
    totalBytesReceived += pcm24kBuffer.length;
    process.stdout.write(`🔊 [Audio Chunk #${audioPacketsReceived}: ${pcm24kBuffer.length} bytes]\n`);
  });

  client.on('text', (text: string) => {
    textReceived += text;
    process.stdout.write(`💬 [Text Chunk]: ${text}\n`);
  });

  client.on('interrupted', () => {
    console.log('⚡ Interrupted signal received');
  });

  client.on('error', (err) => {
    console.error('❌ Client error:', err);
  });

  try {
    await client.connect();
    console.log('✅ Setup handshake completed successfully.');

    console.log('Sending text trigger: "Hello! Introduce yourself in one short sentence."...');
    client.sendText('Hello! Introduce yourself in one short sentence.');

    // Also send audio chunks to test realtimeInput
    const testAudio = generateTestPcmSineWave(0.5, 440);
    const chunkSize = 1600 * 2; // 100ms at 16kHz 16-bit
    console.log(`Sending audio chunks to Gemini Live (${testAudio.length} bytes)...`);
    for (let offset = 0; offset < testAudio.length; offset += chunkSize) {
      const slice = testAudio.subarray(offset, Math.min(offset + chunkSize, testAudio.length));
      client.sendAudioChunk(slice);
      await new Promise((r) => setTimeout(r, 80));
    }

    console.log('Waiting for Gemini Live response...');
    await new Promise((r) => setTimeout(r, 6000));

    console.log('\n--- 📊 Test Results ---');
    console.log(`Audio Packets Received: ${audioPacketsReceived}`);
    console.log(`Total Audio Bytes: ${totalBytesReceived} bytes (~${(totalBytesReceived / (24000 * 2)).toFixed(2)}s of 24kHz audio)`);
    console.log(`Text Output: "${textReceived.trim() || 'N/A'}"`);

    client.disconnect();
    console.log('✅ Gemini Live test finished successfully.\n');
  } catch (err: any) {
    console.error('❌ Test failed:', err.message || err);
    client.disconnect();
    process.exit(1);
  }
}

testGeminiLive();
