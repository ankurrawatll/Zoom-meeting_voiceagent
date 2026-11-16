"""
Windows WASAPI Audio Loopback Capture Worker.
Captures real-time audio rendered to the default speaker / headphones,
converts it to 16,000 Hz 16-bit Linear PCM (mono, Little-Endian),
and streams it directly to standard output (binary stdout) in 20ms chunks.
"""

import sys
import os
import signal
import numpy as np
import soundcard as sc

# Ensure stdout is in unbuffered binary mode on Windows
if sys.platform == 'win32':
    import msvcrt
    msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)

def handle_sigterm(signum, frame):
    sys.exit(0)

signal.signal(signal.SIGINT, handle_sigterm)
signal.signal(signal.SIGTERM, handle_sigterm)

def run_loopback():
    sample_rate = 16000
    channels = 1
    chunk_frames = 320  # 20ms at 16kHz (640 bytes per chunk)

    try:
        default_speaker = sc.default_speaker()
        sys.stderr.write(f"[WASAPI Loopback] Target Speaker: {default_speaker.name}\n")
        sys.stderr.flush()

        loopback_mic = sc.get_microphone(id=str(default_speaker.id), include_loopback=True)
        sys.stderr.write(f"[WASAPI Loopback] Loopback Device: {loopback_mic.name}\n")
        sys.stderr.write(f"[WASAPI Loopback] Streaming 16kHz 16-bit Mono PCM (20ms frames)...\n")
        sys.stderr.flush()

        with loopback_mic.recorder(samplerate=sample_rate, channels=channels) as recorder:
            while True:
                # Read float32 samples [-1.0, 1.0]
                samples = recorder.record(numframes=chunk_frames)
                # Convert to signed 16-bit integers
                int16_samples = np.clip(samples * 32767, -32768, 32767).astype(np.int16)
                # Stream raw binary bytes to stdout
                sys.stdout.buffer.write(int16_samples.tobytes())
                sys.stdout.buffer.flush()

    except Exception as e:
        sys.stderr.write(f"[WASAPI Loopback Error]: {e}\n")
        sys.stderr.flush()
        sys.exit(1)

if __name__ == '__main__':
    run_loopback()

