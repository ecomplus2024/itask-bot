"use client";

// Live voice conversation: mic → PCM16 → authenticated server relay →
// Deepgram Nova-3 STT (language pinned in user settings). Final
// utterances go to the ephemeral /api/voice/chat endpoint; bot replies
// are spoken back via server-side Edge TTS (voice pinned in settings),
// with browser speechSynthesis only as a last-resort fallback.
// Barge-in: Deepgram's SpeechStarted event cancels TTS the moment the
// user talks over it.

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
// Short acknowledgements played while the bot thinks — picked at
// random so consecutive turns don't sound robotic. Keyed by the
// user's voice-language setting.
const FILLERS: Record<string, string[]> = {
  vi: [
    "Vâng ạ.",
    "Em xem ngay ạ.",
    "Dạ, em kiểm tra ạ.",
    "Vâng, để em xem ạ.",
  ],
  en: [
    "Sure.",
    "One moment.",
    "Let me check.",
    "On it.",
  ],
};

import { dgToBcp } from "./voice-langs";

import { startMicCapture, type MicCapture } from "./mic";

export class VoiceSession {
  private ws: WebSocket | null = null;
  private mic: MicCapture | null = null;
  private finals: string[] = [];
  private ev: VoiceEvents;
  private status: VoiceStatus = "off";
  private voicesReady = false;
  private dgLang = "vi";
  private bcp = "vi-VN";

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
    if (this.status !== "off" && this.status !== "error") return;
    this.setStatus("connecting");

    // Mic capture requires a secure context (localhost or HTTPS) —
    // over plain http://<lan-ip> browsers block mediaDevices entirely.
    if (!navigator.mediaDevices?.getUserMedia) {
      this.fail("insecure_context");
      return;
    }

    // Pinned voice language — fillers and the browser-TTS fallback
    // must match what the server-side TTS will speak in.
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d) => {
        const lang = d?.settings?.voiceLanguage as string | undefined;
        if (lang) {
          this.dgLang = lang;
          this.bcp = dgToBcp(lang);
        }
      })
      .catch(() => {});

    // 1) Mic → PCM16 16kHz chunks → relay WebSocket
    try {
      this.mic = await startMicCapture((pcm) => {
        if (this.ws?.readyState === WebSocket.OPEN)
          this.ws.send(pcm.buffer as ArrayBuffer);
      });
    } catch (e) {
      this.fail(
        e instanceof Error && e.message === "insecure_context"
          ? "insecure_context"
          : "mic_denied"
      );
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
      if (this.status !== "off" && this.status !== "error") this.stop();
    };
    this.setStatus("listening");
  }

  /** Tear down hardware/sockets but stay in the 'error' state so the
   * UI can keep showing what went wrong until the user dismisses it. */
  private fail(code: string) {
    this.teardown();
    this.status = "error";
    this.ev.onStatus("error");
    this.ev.onError(code);
  }

  private teardown() {
    this.cancelSpeech();
    this.finals = [];
    try {
      this.ws?.send(JSON.stringify({ type: "voice_stop" }));
    } catch {}
    this.ws?.close();
    this.ws = null;
    this.mic?.stop();
    this.mic = null;
    this.ev.onInterim("");
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
      this.fail(m.message === "no_deepgram_key" ? "no_deepgram_key" : "dg_error");
      return;
    }
    if (m.type === "voice_closed") {
      this.fail("dg_closed");
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

    // Interim results also arrive while the bot is speaking (barge-in
    // preview) — but only finals trigger the filler + send path below.

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

  /** Instant audible acknowledgement while the LLM orchestrates —
   * the "filler audio" trick production voice agents use to mask
   * tool/thinking latency. */
  filler() {
    if (this.status === "off" || this.status === "connecting") return;
    const list = FILLERS[this.dgLang.split("-")[0]] ?? FILLERS.en;
    this.enqueue(list[Math.floor(Math.random() * list.length)]);
  }

  private audio: HTMLAudioElement | null = null;
  private audioUrl: string | null = null;
  private speakQueue: string[] = [];
  private playing = false;
  private playResolve: (() => void) | null = null;
  private ttsBuffer = "";

  /** Speak a whole (already-complete) reply. */
  speak(text: string) {
    if (this.status === "off") return;
    const clean = this.cleanForSpeech(text);
    if (clean) this.enqueue(clean);
  }

  /** Feed streaming deltas — sentences are spoken as soon as they are
   * complete, so the bot starts talking while it is still writing. */
  speakStream(delta: string) {
    if (this.status === "off") return;
    this.ttsBuffer += delta;
    this.pumpSentences(false);
  }

  /** Call when the stream ends — speaks whatever is left in the buffer. */
  speakFlush() {
    this.pumpSentences(true);
  }

  private pumpSentences(flush: boolean) {
    while (true) {
      // Drop completed control markers (e.g. [[SUGGEST: ...]]).
      this.ttsBuffer = this.ttsBuffer.replace(/\[\[[^\]]*\]\]/g, "");
      // Don't cut inside an incomplete marker — wait for "]]" first.
      const open = this.ttsBuffer.indexOf("[[");
      const limit = open === -1 ? this.ttsBuffer.length : open;
      if (limit === 0) return;
      const buf = this.ttsBuffer.slice(0, limit);
      const m = /[.!?…\n]/.exec(buf);
      if (m && m.index >= 3) {
        const sentence = this.cleanForSpeech(buf.slice(0, m.index + 1));
        this.ttsBuffer = this.ttsBuffer.slice(m.index + 1);
        if (sentence) this.enqueue(sentence);
        continue;
      }
      if (flush) {
        const rest = this.cleanForSpeech(buf);
        this.ttsBuffer = this.ttsBuffer.slice(limit);
        if (rest) this.enqueue(rest);
        continue;
      }
      return;
    }
  }

  private cleanForSpeech(text: string) {
    return text
      .replace(/\[\[[^\]]*\]\]/g, "")
      .replace(/\[[^\]]*\]\([^)]*\)/g, "") // markdown links
      .replace(/[#*`>_]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  private enqueue(sentence: string) {
    this.speakQueue.push(sentence);
    void this.pumpQueue();
  }

  private async pumpQueue() {
    if (this.playing) return;
    const text = this.speakQueue.shift();
    if (text === undefined) {
      if (this.status === "speaking") this.setStatus("listening");
      return;
    }
    this.playing = true;
    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error("tts_failed");
      const url = URL.createObjectURL(await res.blob());
      const audio = new Audio(url);
      this.audio = audio;
      this.audioUrl = url;
      if ((this.status as VoiceStatus) === "off") {
        this.releaseAudio();
        return;
      }
      this.setStatus("speaking");
      await new Promise<void>((resolve) => {
        this.playResolve = () => {
          this.playResolve = null;
          resolve();
        };
        audio.onended = audio.onerror = this.playResolve;
        audio.play().catch(() => this.playResolve?.());
      });
      this.releaseAudio();
    } catch {
      this.releaseAudio();
      this.speakFallback(text);
    } finally {
      this.playing = false;
      if (this.status !== "off") void this.pumpQueue();
    }
  }

  private releaseAudio() {
    this.audio?.pause();
    this.audio = null;
    if (this.audioUrl) URL.revokeObjectURL(this.audioUrl);
    this.audioUrl = null;
    if (this.status === "speaking" && !this.playing)
      this.setStatus("listening");
  }

  private speakFallback(clean: string) {
    if (typeof speechSynthesis === "undefined") return;
    const u = new SpeechSynthesisUtterance(clean.slice(0, 1200));
    const voices = speechSynthesis.getVoices();
    const prefix = this.bcp.split("-")[0];
    const match =
      voices.find((v) => v.lang.replace("_", "-") === this.bcp) ??
      voices.find((v) => v.lang.replace("_", "-").startsWith(prefix));
    if (match) u.voice = match;
    u.lang = match?.lang ?? this.bcp;
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
    this.speakQueue = [];
    this.ttsBuffer = "";
    this.playResolve?.(); // unblock an in-flight pumpQueue await
    if (this.audio) {
      this.audio.pause();
      if (this.audioUrl) URL.revokeObjectURL(this.audioUrl);
      this.audio = null;
      this.audioUrl = null;
      if (this.status === "speaking") this.setStatus("listening");
    }
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
  }

  stop() {
    this.teardown();
    if (this.status !== "off") {
      this.status = "off";
      this.ev.onStatus("off");
    }
  }
}
