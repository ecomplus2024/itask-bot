"use client";

// Live voice conversation: mic → PCM16 → authenticated server relay →
// Deepgram Nova-3 STT (vi). Final utterances are handed to the caller
// (which posts them as room messages); bot replies are spoken back via
// the browser's Vietnamese speechSynthesis. Barge-in: Deepgram's
// SpeechStarted event cancels TTS the moment the user talks over it.

export type VoiceStatus =
  | "off"
  | "connecting"
  | "listening"
  | "speaking"
  | "error";

export type VoiceEvents = {
  onStatus: (s: VoiceStatus) => void;
  onInterim: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (message: string) => void;
};

// AudioWorklet processor: hands Float32 mic chunks to the main thread.
// Inlined via Blob URL so no extra static asset is needed.
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

export class VoiceSession {
  private ws: WebSocket | null = null;
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private finals: string[] = [];
  private ev: VoiceEvents;
  private status: VoiceStatus = "off";
  private voicesReady = false;

  constructor(events: VoiceEvents) {
    this.ev = events;
    // Preload voices — browsers populate the list asynchronously.
    if (typeof speechSynthesis !== "undefined") {
      speechSynthesis.getVoices();
      speechSynthesis.onvoiceschanged = () => {
        this.voicesReady = true;
      };
    }
  }

  private setStatus(s: VoiceStatus) {
    if (this.status === s) return;
    this.status = s;
    this.ev.onStatus(s);
  }

  async start() {
    if (this.status !== "off") return;
    this.setStatus("connecting");

    // 1) Mic
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
    } catch {
      this.setStatus("error");
      this.ev.onError("mic_denied");
      this.stop();
      return;
    }

    // 2) Relay WebSocket (own socket — independent of the room-refresh one)
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const wsPort = (window as any).itaskDesktop?.wsPort || 3001;
    this.ws = new WebSocket(`${proto}://${location.hostname}:${wsPort}`);
    this.ws.binaryType = "arraybuffer";
    this.ws.onmessage = (e) => this.onMessage(e.data);
    this.ws.onopen = () =>
      this.ws?.send(JSON.stringify({ type: "voice_start" }));
    this.ws.onclose = () => {
      if (this.status !== "off") this.stop();
    };

    // 3) Audio pipeline: capture at native rate, resample to 16k PCM16
    try {
      this.ctx = new AudioContext();
      const src = this.ctx.createMediaStreamSource(this.stream);
      const url = URL.createObjectURL(
        new Blob([WORKLET_SRC], { type: "application/javascript" })
      );
      await this.ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      this.node = new AudioWorkletNode(this.ctx, "pcm");
      const inRate = this.ctx.sampleRate;
      this.node.port.onmessage = (e) => {
        const pcm = downsample(e.data as Float32Array, inRate, 16000);
        if (this.ws?.readyState === WebSocket.OPEN)
          this.ws.send(pcm.buffer as ArrayBuffer);
      };
      src.connect(this.node);
      this.setStatus("listening");
    } catch (e) {
      this.setStatus("error");
      this.ev.onError(String(e));
      this.stop();
    }
  }

  private onMessage(data: string) {
    let m: {
      type?: string;
      is_final?: boolean;
      speech_final?: boolean;
      channel?: { alternatives?: { transcript?: string }[] };
      message?: string;
    };
    try {
      m = JSON.parse(data);
    } catch {
      return;
    }

    if (m.type === "voice_error") {
      this.ev.onError(m.message ?? "voice_error");
      if (m.message === "no_deepgram_key") this.stop();
      return;
    }
    if (m.type === "voice_closed") {
      this.stop();
      return;
    }

    // Barge-in — user started talking while the bot is speaking.
    if (m.type === "SpeechStarted") {
      this.cancelSpeech();
      this.setStatus("listening");
      return;
    }

    if (m.type === "UtteranceEnd") {
      this.flushFinal();
      return;
    }

    if (m.type === "Results") {
      const text = m.channel?.alternatives?.[0]?.transcript?.trim() ?? "";
      if (m.is_final) {
        if (text) this.finals.push(text);
        this.ev.onInterim("");
        if (m.speech_final) this.flushFinal();
      } else if (text) {
        this.ev.onInterim(text);
      }
    }
  }

  private flushFinal() {
    const text = this.finals.join(" ").trim();
    this.finals = [];
    this.ev.onInterim("");
    if (text) this.ev.onFinal(text);
  }

  /** Speak a bot reply using a Vietnamese browser voice. */
  speak(text: string) {
    if (typeof speechSynthesis === "undefined" || this.status === "off")
      return;
    const clean = text
      .replace(/\[\[SUGGEST:[^\]]*\]\]/g, "")
      .replace(/\[[^\]]*\]\([^)]*\)/g, "") // markdown links
      .replace(/[#*`>_-]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!clean) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(clean.slice(0, 1200));
    const voices = speechSynthesis.getVoices();
    const vi =
      voices.find((v) => v.lang === "vi-VN") ??
      voices.find((v) => v.lang.startsWith("vi"));
    if (vi) u.voice = vi;
    u.lang = vi?.lang ?? "vi-VN";
    u.rate = 1.05;
    u.onstart = () => {
      if (this.status !== "off") this.setStatus("speaking");
    };
    u.onend = u.onerror = () => {
      if (this.status === "speaking") this.setStatus("listening");
    };
    speechSynthesis.speak(u);
  }

  cancelSpeech() {
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
  }

  stop() {
    this.cancelSpeech();
    this.finals = [];
    try {
      this.ws?.send(JSON.stringify({ type: "voice_stop" }));
    } catch {}
    this.ws?.close();
    this.ws = null;
    this.node?.disconnect();
    this.node = null;
    this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.ev.onInterim("");
    if (this.status !== "off") {
      this.status = "off";
      this.ev.onStatus("off");
    }
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
