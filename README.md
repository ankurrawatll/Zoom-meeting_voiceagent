# 🎙️ Autonomous AI Meeting Voice Agent

> An autonomous AI voice agent that joins live Zoom, Google Meet, and MS Teams calls via link with zero client install. Powered by Gemini Live for sub-400ms speech-to-speech dialogue, it actively converses with participants and automatically generates an investment pitch scorecard, performance metrics, and actionable feedback post-call.

---

## 🏗️ Architecture Overview

Unlike traditional bots that rely on clunky third-party enterprise marketplace approvals or high-latency STT-LLM-TTS pipelines, this agent uses a **zero-trust headless browser orchestration pipeline**:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Chromium Web Page                               │
│                                                                        │
│   [Zoom / Teams / Meet Web Client]                                     │
│            ▲                                     │                     │
│            │ (getUserMedia synthetic mic)        │ (AudioNode / track) │
│            │                                     ▼                     │
│   [Synthetic Mic Source]                [Remote Audio Capture]         │
│     (AudioBufferSourceNode)                (ScriptProcessor 48kHz)     │
│             ▲                                    │                     │
└─────────────┼────────────────────────────────────┼─────────────────────┘
              │                                    │
    ws://127.0.0.1:8765                  ws://127.0.0.1:8765
    (Gemini 24kHz -> Browser)            (Browser 48kHz -> Bridge)
              │                                    │
┌─────────────┴────────────────────────────────────▼─────────────────────┐
│                     Node.js AudioBridge & Agent                        │
│                                                                        │
│   • Downsamples 48kHz -> 16kHz PCM linear via fast box filter          │
│   • Truncates playback instantly on Gemini interruption events         │
└────────────────────────────┬───────────────────────────────────────────┘
                             │
     wss://generativelanguage.googleapis.com/.../BidiGenerateContent
     (16kHz audio in, 24kHz audio out)
                             │
┌────────────────────────────▼───────────────────────────────────────────┐
│               Google Gemini Live (BidiGenerateContent)                 │
│              Model: gemini-2.5-flash-native-audio-preview              │
└────────────────────────────────────────────────────────────────────────┘
```

---

## ⚡ Quick Start

### 1. Prerequisites
- **Node.js**: v20+ LTS
- **Google Gemini API Key**: [Get key from Google AI Studio](https://aistudio.google.com/)

### 2. Installation
```bash
git clone https://github.com/ankurrawatll/Zoom-meeting_voiceagent.git
cd Zoom-meeting_voiceagent
npm install
npx playwright install chromium
```

### 3. Environment Configuration
Create a `.env` file in the root directory:
```env
GEMINI_API_KEY=your_gemini_api_key_here
GEMINI_MODEL=models/gemini-2.5-flash-native-audio-preview-12-2025
STUDIO_PORT=3050
AUDIO_BRIDGE_PORT=8765
HEADLESS=true
BOT_NAME="Alex (Investor)"
BOT_VOICE="Puck"
```

---

## 🌐 Running the Studio Web Dashboard

Launch the interactive control studio:
```bash
npm run ui
```
Open **`http://localhost:3050`** in your browser. From the dashboard you can:
- Paste any Zoom, Google Meet, or Teams invite link.
- Select pre-configured personas (VC Investor, System Design Interviewer, Startup Co-Founder, Pitch Coach).
- Toggle between **Open Dialogue** and **Wake-Word Only** (*"Hey Alex"*).
- Watch the live dialogue transcript stream in real time.
- View the automated **Pitch Performance Scorecard & Evaluation** after each session.

---

## 🚀 Running via CLI

### Join a Zoom Meeting
```bash
npx tsx src/index.ts --url "https://zoom.us/j/1234567890?pwd=your_password" --name "Alex (Investor)"
```

### Join a Microsoft Teams Meeting
```bash
npx tsx src/index.ts --url "https://teams.microsoft.com/l/meetup-join/..." --name "Alex (Investor)"
```

### Run in Headless Mode (Background)
```bash
npx tsx src/index.ts --url "<MEETING_URL>" --headless true
```

---

## 📁 Project Structure

- `src/server.ts` — Studio HTTP & WebSocket Control Hub.
- `src/web/public/index.html` — Lightweight Single-Page Application dashboard with live review & scorecard.
- `src/web/presets.ts` — Pre-configured agent personas, greetings, and system rules.
- `src/bot/meetingBot.ts` — Main coordinator orchestrating Browser, Audio Bridge, Gemini Live, and Platform Drivers.
- `src/bot/zoomDriver.ts` — Zoom Web Client automation (join URL converter, waiting room bypass, audio setup, mic unmute).
- `src/bot/teamsDriver.ts` — Microsoft Teams Web automation (prejoin lobby, device toggles, join confirmation).
- `src/audio/audioBridge.ts` — High-throughput local WebSocket bridge between browser tab and Node.js.
- `src/audio/injectAudioHook.ts` — Injected script overriding `getUserMedia` (synthetic mic) and hooking audio nodes.
- `src/audio/resampler.ts` — Linear PCM converters: Float32 <-> Int16, 48kHz downsampling to 16kHz, 24kHz upsampling.
- `src/ai/geminiLiveClient.ts` — Gemini Live Bidirectional WebSocket client (`BidiGenerateContent`).
- `src/ai/meetingAnalyzer.ts` — Multimodal post-meeting pitch evaluation and 5-dimensional scorecard scoring.

---

## 🛡️ Privacy & Security
- **Ephemeral RAM Audio**: Meeting audio buffers exist solely in RAM for live streaming and are discarded immediately.
- **Process Isolation**: Every meeting runs in an independent, sandboxed Chromium context that is destroyed on disconnect.
- **Zero Client Dependencies**: Meeting participants do not download or install anything.

---

## 📄 License
MIT
