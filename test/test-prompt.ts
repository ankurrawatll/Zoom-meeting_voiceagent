import { GeminiLiveClient } from '../src/ai/geminiLiveClient.js';
import { config } from '../src/config/env.js';

async function testSystemDirective() {
  const systemPrompt =
    `You are Alex, a friendly, sharp Venture Capital & Angel Investor in a 1-on-1 meeting with a startup founder.\n` +
    `You are actively conversing with the founder in real-time. Listen attentively to their pitch, react naturally with encouraging comments, and ask thoughtful questions about their problem, product, traction, business model, and market.\n` +
    `Keep your spoken responses natural, conversational, and concise (1 to 2 sentences) so the conversation flows back and forth like a real discussion.`;

  const client = new GeminiLiveClient({
    apiKey: config.geminiApiKey,
    model: config.model,
    voiceName: 'Puck',
    systemInstruction: systemPrompt,
  });

  client.on('text', (txt) => console.log('💬 Text:', txt));
  client.on('audio', (buf) => console.log('🔊 Audio chunk:', buf.length));

  await client.connect();
  console.log('Sending greeting prompt...');

  client.sendText(
    "[Meeting started. Greet the founder warmly: Introduce yourself as Alex, say you're excited to meet them, and invite them to start with a quick overview of what they're building.]"
  );

  await new Promise((r) => setTimeout(r, 6000));
  client.disconnect();
  console.log('Done test.');
  process.exit(0);
}

testSystemDirective().catch(console.error);
