/**
 * Generates the JavaScript code to be injected into the browser via page.addInitScript().
 * Hooks:
 * 1. navigator.mediaDevices.getUserMedia -> Provides synthetic microphone with Gemini speech, disables real webcam.
 * 2. AudioNode.prototype.connect & RTCPeerConnection & HTMLMediaElement -> Captures remote participant audio without feedback loops or duplicate streams.
 * 3. Bidirectional WebSocket link to the local Node.js AudioBridge.
 */
export function getInjectAudioHookScript(bridgePort: number = 8765): string {
  return `
(() => {
  if (window.__audioHookInstalled) return;
  if (window.top !== window.self) return; // Only run in top window, ignore tracking/recaptcha iframes
  window.__audioHookInstalled = true;

  console.log('[AudioHook] 🚀 Installing Audio & Video Hook...');

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    console.error('[AudioHook] ❌ Web Audio API not supported!');
    return;
  }

  // 1. Initialize Bot Audio Context (for synthetic mic output)
  const audioCtx = new AudioContextClass({ sampleRate: 48000 });
  window.__botAudioCtx = audioCtx;

  const resumeCtx = async () => {
    if (audioCtx.state === 'suspended') {
      try {
        await audioCtx.resume();
        console.log('[AudioHook] 🎙️ AudioContext resumed successfully (state: ' + audioCtx.state + ')');
      } catch (e) {}
    }
  };
  ['click', 'keydown', 'touchstart', 'mousedown', 'pointerdown'].forEach(ev => window.addEventListener(ev, resumeCtx, { once: true }));
  setInterval(resumeCtx, 1000);

  // 2. Synthetic Microphone Pipeline (Bot Mouth)
  const masterBotGain = audioCtx.createGain();
  masterBotGain.gain.value = 1.0;
  window.__botMasterGain = masterBotGain;

  const activeDestinations = new Set();
  const activeSources = [];
  let nextPlayTime = audioCtx.currentTime;

  // Continuous faint ambient carrier so Zoom's microphone health check ALWAYS detects live active signal
  // (Prevents: "Your microphone is not working. Please check your connection or use a different mic")
  try {
    const carrier = audioCtx.createOscillator();
    carrier.type = 'sine';
    carrier.frequency.value = 140;
    const carrierGain = audioCtx.createGain();
    carrierGain.gain.value = 0.001; // Ultra-faint, detected by Zoom audio meter as healthy mic
    carrier.connect(carrierGain);
    carrierGain.connect(masterBotGain);
    carrier.start();
  } catch (e) {}

  // 3. Connect to Node.js AudioBridge WebSocket
  let ws = null;
  let isConnecting = false;

  function connectBridge() {
    if (isConnecting || (ws && ws.readyState === WebSocket.OPEN)) return;
    isConnecting = true;

    try {
      ws = new WebSocket('ws://127.0.0.1:${bridgePort}');
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        isConnecting = false;
        console.log('[AudioHook] ✅ Connected to AudioBridge ws://127.0.0.1:${bridgePort}');
      };

      ws.onmessage = (event) => {
        if (typeof event.data === 'string') {
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'interrupt') {
              console.log('[AudioHook] ⚡ Interrupt signal received. Stopping queued playback.');
              for (const src of activeSources) {
                try { src.stop(); } catch (e) {}
              }
              activeSources.length = 0;
              nextPlayTime = audioCtx.currentTime;
            }
          } catch (e) {}
        } else if (event.data instanceof ArrayBuffer) {
          // Received 24kHz 16-bit PCM audio from Gemini Live
          queueGeminiAudioBuffer(event.data);
        }
      };

      ws.onclose = () => {
        isConnecting = false;
        ws = null;
        setTimeout(connectBridge, 2000);
      };

      ws.onerror = () => {
        isConnecting = false;
        if (ws) ws.close();
      };
    } catch (e) {
      isConnecting = false;
      setTimeout(connectBridge, 2000);
    }
  }

  connectBridge();

  function queueGeminiAudioBuffer(arrayBuffer) {
    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }

    // Ensure even byte count for Int16Array
    const byteLen = arrayBuffer.byteLength - (arrayBuffer.byteLength % 2);
    const int16 = new Int16Array(arrayBuffer, 0, byteLen / 2);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768.0;
    }

    // Gemini outputs 24,000 Hz. Web Audio automatically resamples to destination rate.
    const buffer = audioCtx.createBuffer(1, float32.length, 24000);
    buffer.copyToChannel(float32, 0);

    const source = audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(masterBotGain);

    activeSources.push(source);
    source.onended = () => {
      const idx = activeSources.indexOf(source);
      if (idx !== -1) activeSources.splice(idx, 1);
    };

    const now = audioCtx.currentTime;
    if (nextPlayTime < now) {
      nextPlayTime = now + 0.03; // 30ms jitter safety margin
    }
    source.start(nextPlayTime);
    nextPlayTime += buffer.duration;
  }

  // 4. Hook navigator.mediaDevices.getUserMedia (Mic Hijack & Full Device Metadata Emulation)
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    const origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async function(constraints) {
      console.log('[AudioHook] 🎤 getUserMedia called:', JSON.stringify(constraints));
      await resumeCtx();

      const tracks = [];

      // Audio: Supply fresh synthetic microphone stream from Gemini Live with matching device metadata
      if (constraints && constraints.audio) {
        // Create a BRAND NEW MediaStreamAudioDestinationNode for this request so it is never in 'ended' state
        const freshDest = audioCtx.createMediaStreamDestination();
        masterBotGain.connect(freshDest);
        activeDestinations.add(freshDest);

        const synthTrack = freshDest.stream.getAudioTracks()[0];

        // Call original getUserMedia (with Chromium fake device) to extract real device settings & ID
        let realStream = null;
        let realTrack = null;
        try {
          realStream = await origGetUserMedia(constraints);
          realTrack = realStream ? realStream.getAudioTracks()[0] : null;
        } catch (e) {
          try {
            realStream = await origGetUserMedia({ audio: true, video: false });
            realTrack = realStream ? realStream.getAudioTracks()[0] : null;
          } catch (_) {}
        }

        // Determine requested deviceId
        let reqDeviceId = 'default';
        if (typeof constraints.audio === 'object' && constraints.audio.deviceId) {
          const d = constraints.audio.deviceId;
          reqDeviceId = typeof d === 'string' ? d : (d.exact || d.ideal || 'default');
        }

        const realSettings = realTrack && realTrack.getSettings ? realTrack.getSettings() : {};
        const finalDeviceId = reqDeviceId !== 'default' ? reqDeviceId : (realSettings.deviceId || 'default');
        const finalLabel = (realTrack && realTrack.label) || 'Fake Default Audio Input';

        function decorateTrack(t) {
          try {
            Object.defineProperty(t, 'label', { get: () => finalLabel, configurable: true });
            if (realTrack && realTrack.id) {
              Object.defineProperty(t, 'id', { get: () => realTrack.id, configurable: true });
            }
          } catch (_) {}

          t.getSettings = () => ({
            deviceId: finalDeviceId,
            groupId: realSettings.groupId || 'default',
            channelCount: 1,
            sampleRate: audioCtx.sampleRate || 48000,
            latency: 0.01,
            echoCancellation: false,
            autoGainControl: false,
            noiseSuppression: false,
            ...realSettings,
            deviceId: finalDeviceId,
          });

          if (realTrack && realTrack.getCapabilities) {
            t.getCapabilities = () => realTrack.getCapabilities();
          } else {
            t.getCapabilities = () => ({
              deviceId: finalDeviceId,
              channelCount: { min: 1, max: 2 },
              sampleRate: { min: 16000, max: 48000 },
              echoCancellation: [true, false],
              autoGainControl: [true, false],
              noiseSuppression: [true, false],
            });
          }

          t.getConstraints = () => (typeof constraints.audio === 'object' ? constraints.audio : {});

          // applyConstraints MUST return a resolved Promise so Zoom never flags microphone error
          t.applyConstraints = async (newConstraints) => {
            if (realTrack && realTrack.applyConstraints) {
              try { await realTrack.applyConstraints(newConstraints); } catch (_) {}
            }
            return Promise.resolve();
          };

          // clone() must return a decorated clone
          const origClone = t.clone.bind(t);
          t.clone = () => {
            const cloned = origClone();
            decorateTrack(cloned);
            return cloned;
          };

          // Cleanup when Zoom stops this specific track
          t.addEventListener('ended', () => {
            try { masterBotGain.disconnect(freshDest); } catch (_) {}
            activeDestinations.delete(freshDest);
            if (realTrack) {
              try { realTrack.stop(); } catch (_) {}
            }
          });
        }

        decorateTrack(synthTrack);
        tracks.push(synthTrack);
        console.log('[AudioHook] 🎙️ Synthetic microphone track supplied to Zoom (deviceId: ' + finalDeviceId + ').');
      }

      // Video: NEVER access real hardware camera! Provide synthetic blank canvas
      if (constraints && constraints.video) {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = 320;
          canvas.height = 240;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#0f172a';
          ctx.fillRect(0, 0, 320, 240);
          ctx.fillStyle = '#38bdf8';
          ctx.font = 'bold 18px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText('Investor AI', 160, 120);
          const canvasStream = canvas.captureStream(5);
          const videoTrack = canvasStream.getVideoTracks()[0];
          if (videoTrack) tracks.push(videoTrack);
        } catch (e) {
          console.warn('[AudioHook] Could not create dummy canvas track:', e);
        }
      }

      if (tracks.length > 0) {
        return new MediaStream(tracks);
      }

      return origGetUserMedia(constraints);
    };
  }

  console.log('[AudioHook] ✅ Audio & Video hook installed successfully.');
})();
`;
}
