import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from project root or parent backend
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../../backend/.env') });

export const config = {
  geminiApiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENAI_API_KEY || '',
  botName: process.env.BOT_NAME || 'Investor AI',
  botVoice: process.env.BOT_VOICE || 'Puck', // Options: Puck, Charon, Kore, Fenrir, Aoede
  audioBridgePort: parseInt(process.env.AUDIO_BRIDGE_PORT || '8765', 10),
  headless: process.env.HEADLESS === 'true',
  model: process.env.GEMINI_MODEL || 'models/gemini-2.5-flash-native-audio-preview-12-2025',
};

export function validateConfig() {
  if (!config.geminiApiKey) {
    console.warn('⚠️ WARNING: GEMINI_API_KEY is not set in environment or .env file!');
    console.warn('   Add GEMINI_API_KEY to voiceagent/.env');
  }
}
