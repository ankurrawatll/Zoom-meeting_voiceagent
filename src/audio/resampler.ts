/**
 * High-performance audio resampling & PCM format conversion utilities.
 * Handles conversions between:
 * - Browser Web Audio (48,000 Hz)
 * - Gemini Live Input (16,000 Hz, 16-bit Linear PCM, Little-Endian)
 * - Gemini Live Output (24,000 Hz, 16-bit Linear PCM, Little-Endian)
 */

/**
 * Converts Float32Array [-1.0, 1.0] to 16-bit Linear PCM Buffer.
 */
export function float32ToInt16Buffer(float32Array: Float32Array): Buffer {
  const buffer = Buffer.alloc(float32Array.length * 2);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    const val = s < 0 ? s * 0x8000 : s * 0x7fff;
    buffer.writeInt16LE(Math.floor(val), i * 2);
  }
  return buffer;
}

/**
 * Converts 16-bit Linear PCM Buffer to Float32Array [-1.0, 1.0].
 */
export function int16BufferToFloat32(buffer: Buffer): Float32Array {
  const sampleCount = Math.floor(buffer.length / 2);
  const float32 = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    const int16 = buffer.readInt16LE(i * 2);
    float32[i] = int16 < 0 ? int16 / 0x8000 : int16 / 0x7fff;
  }
  return float32;
}

/**
 * Downsamples 16-bit Linear PCM from 48,000 Hz to 16,000 Hz (ratio 3:1).
 * Uses a 3-tap box average filter to avoid aliasing artifacts.
 */
export function downsample48kTo16k(inputBuffer: Buffer): Buffer {
  const inputSamples = Math.floor(inputBuffer.length / 2);
  const outputSamples = Math.floor(inputSamples / 3);
  const outputBuffer = Buffer.alloc(outputSamples * 2);

  for (let i = 0; i < outputSamples; i++) {
    const idx = i * 3;
    const s0 = inputBuffer.readInt16LE(idx * 2);
    const s1 = inputBuffer.readInt16LE((idx + 1) * 2);
    const s2 = inputBuffer.readInt16LE((idx + 2) * 2);

    // 3-point average
    const avg = Math.round((s0 + s1 + s2) / 3);
    outputBuffer.writeInt16LE(avg, i * 2);
  }

  return outputBuffer;
}

/**
 * Upsamples 16-bit Linear PCM from 24,000 Hz to 48,000 Hz (ratio 1:2).
 * Uses linear interpolation for smooth playback in Web Audio.
 */
export function upsample24kTo48k(inputBuffer: Buffer): Buffer {
  const inputSamples = Math.floor(inputBuffer.length / 2);
  const outputSamples = inputSamples * 2;
  const outputBuffer = Buffer.alloc(outputSamples * 2);

  for (let i = 0; i < inputSamples; i++) {
    const curr = inputBuffer.readInt16LE(i * 2);
    const next = i + 1 < inputSamples ? inputBuffer.readInt16LE((i + 1) * 2) : curr;

    // Sample 0
    outputBuffer.writeInt16LE(curr, (i * 2) * 2);
    // Sample 1 (midpoint interpolation)
    const mid = Math.round((curr + next) / 2);
    outputBuffer.writeInt16LE(mid, (i * 2 + 1) * 2);
  }

  return outputBuffer;
}

/**
 * Arbitrary sample rate converter for 16-bit PCM (Linear Interpolation).
 */
export function resamplePcm16(
  inputBuffer: Buffer,
  fromRate: number,
  toRate: number
): Buffer {
  if (fromRate === toRate) return inputBuffer;

  if (fromRate === 48000 && toRate === 16000) {
    return downsample48kTo16k(inputBuffer);
  }
  if (fromRate === 24000 && toRate === 48000) {
    return upsample24kTo48k(inputBuffer);
  }

  const inputSamples = Math.floor(inputBuffer.length / 2);
  const ratio = toRate / fromRate;
  const outputSamples = Math.floor(inputSamples * ratio);
  const outputBuffer = Buffer.alloc(outputSamples * 2);

  for (let i = 0; i < outputSamples; i++) {
    const srcIndex = i / ratio;
    const i0 = Math.floor(srcIndex);
    const i1 = Math.min(i0 + 1, inputSamples - 1);
    const frac = srcIndex - i0;

    const s0 = inputBuffer.readInt16LE(i0 * 2);
    const s1 = inputBuffer.readInt16LE(i1 * 2);

    const interpolated = Math.round(s0 + frac * (s1 - s0));
    outputBuffer.writeInt16LE(interpolated, i * 2);
  }

  return outputBuffer;
}
