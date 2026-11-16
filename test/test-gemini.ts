import { GeminiLiveClient } from '../src/ai/geminiLiveClient.js';
import { config } from '../src/config/env.js';

async function main() {
  const client = new GeminiLiveClient({
    apiKey: config.geminiApiKey,
    model: config.model,
    voiceName: 'Puck',
  });

  client.on('audio', (buf) => console.log('✅ Received audio chunk bytes:', buf.length));
  client.on('text', (txt) => console.log('💬 Received text:', txt));
  client.on('error', (err) => console.error('❌ Error:', err));
  client.on('close', (info) => console.log('🔌 Closed:', info));

  console.log('Connecting...');
  await client.connect();
  console.log('Connected! Sending text prompt...');
  client.sendText('Say hello in one short sentence.');

  await new Promise((res) => setTimeout(res, 6000));
  client.disconnect();
  console.log('Done test.');
  process.exit(0);
}

main().catch(console.error);
