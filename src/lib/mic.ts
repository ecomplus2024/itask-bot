"use client";

// Shared mic capture: getUserMedia → AudioWorklet → PCM16 16kHz chunks.
// Used by both the Deepgram STT path and the Gemini Live path.

const WORKLET_SRC = `
class P extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('pcm', P);
`;

export type MicCapture = {
  stop: () => void;
};

export async function startMicCapture(
  onChunk: (pcm: Int16Array) => void
): Promise<MicCapture> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("insecure_context");

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
    },
  });

  try {
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    const url = URL.createObjectURL(
      new Blob([WORKLET_SRC], { type: "application/javascript" })
    );
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const node = new AudioWorkletNode(ctx, "pcm");
    const inRate = ctx.sampleRate;
    node.port.onmessage = (e) => {
      onChunk(downsample(e.data as Float32Array, inRate, 16000));
    };
    src.connect(node);

    return {
      stop: () => {
        node.disconnect();
        ctx.close().catch(() => {});
        stream.getTracks().forEach((t) => t.stop());
      },
    };
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop());
    throw e;
  }
}

// Linear-interpolation resampler → PCM16 little-endian.
function downsample(input: Float32Array, fromRate: number, toRate: number) {
  const ratio = fromRate / toRate;
  const out = new Int16Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = input[idx] ?? 0;
    const b = input[idx + 1] ?? a;
    const s = Math.max(-1, Math.min(1, a + (b - a) * frac));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

export function pcmToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(bin);
}

export function base64ToPcm(b64: string): Int16Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}
