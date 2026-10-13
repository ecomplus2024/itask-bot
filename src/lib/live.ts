"use client";

// Gemini Live voice mode: the browser connects directly to Google's
// BidiGenerateContent WebSocket using a short-lived ephemeral token —
// audio never touches our server. The model streams native vi-VN
// speech back; tool calls are routed to /api/live/tools so the real
// iTask stack (memory, files, ERP/MCP, ask_bot) still executes.
// Nothing is persisted — a call leaves no chat bubbles; session
// resumption keeps the conversation alive past Google's ~10-minute
// connection cap.

import {
  startMicCapture,
  pcmToBase64,
  base64ToPcm,
  type MicCapture,
} from "./mic";
import type { VoiceStatus } from "./voice";

export type LiveEvents = {
  onStatus: (s: VoiceStatus) => void;
  onInterim: (text: string) => void;
  onError: (code: string) => void;
};

const LIVE_MODEL =
  process.env.NEXT_PUBLIC_GEMINI_LIVE_MODEL ?? "gemini-3.8-live";
const WS_URL =
  "wss://generativelanguage.googleapis.com/ws/" +
  "google.ai.generativelanguage.v1beta.GenerativeService." +
  "BidiGenerateContentConstrained";

export class LiveSession {
  readonly nativeAudio = true; // tells ChatApp to skip the TTS path
  private ws: WebSocket | null = null;
  private mic: MicCapture | null = null;
  private playCtx: AudioContext | null = null;
  private nextPlay = 0;
  private ev: LiveEvents;
  private status: VoiceStatus = "off";
  private roomId: number;
  private resumeHandle: string | null = null;
  private inputText = "";
  private stopped = false;
  private reconnects = 0;
  private ctx: {
    systemInstruction?: string;
    tools?: unknown[];
    speech?: { languageCode?: string; voiceName?: string };
  } | null = null;

  constructor(roomId: number, events: LiveEvents) {
    this.roomId = roomId;
    this.ev = events;
  }

  private setStatus(s: VoiceStatus) {
    if (this.status === s) return;
    this.status = s;
    this.ev.onStatus(s);
  }

  async start() {
    this.setStatus("connecting");

    // 1) Ephemeral token + bot context in parallel.
    const [tokRes, ctxRes] = await Promise.all([
      fetch("/api/live/token", { method: "POST" }),
      fetch(`/api/live/context?roomId=${this.roomId}`),
    ]);
    if (tokRes.status === 412) return this.fail("no_gemini_key");
    const ctx = (await ctxRes.json().catch(() => null)) as {
      available?: boolean;
      reason?: string;
      systemInstruction?: string;
      tools?: unknown[];
      speech?: { languageCode?: string; voiceName?: string };
    } | null;
    if (!tokRes.ok || !ctx?.available)
      return this.fail(ctx?.reason ?? "live_unavailable");
    const { token } = (await tokRes.json()) as { token: string };
    this.ctx = ctx;
    this.resumeHandle = null;
    this.stopped = false;

    // 2) Mic — same PCM16 16kHz capture as the Deepgram path.
    try {
      this.mic = await startMicCapture((pcm) => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(
            JSON.stringify({
              realtimeInput: {
                audio: {
                  data: pcmToBase64(pcm),
                  mimeType: "audio/pcm;rate=16000",
                },
              },
            })
          );
        }
      });
    } catch (e) {
      return this.fail(
        e instanceof Error && e.message === "insecure_context"
          ? "insecure_context"
          : "mic_denied"
      );
    }

    // 3) Connect straight to Google.
    this.connect(token);
  }

  /** Opens (or re-opens) the Google socket and sends the setup frame.
   * On reconnect the stored resumption handle restores the session's
   * context so the conversation keeps flowing seamlessly. */
  private connect(token: string) {
    const ws = new WebSocket(`${WS_URL}?access_token=${token}`);
    this.ws = ws;
    ws.onmessage = (e) => this.onMessage(e.data);
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          setup: {
            model: `models/${LIVE_MODEL}`,
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig: {
                ...(this.ctx?.speech?.languageCode
                  ? { languageCode: this.ctx.speech.languageCode }
                  : {}),
                voiceConfig: {
                  prebuiltVoiceConfig: {
                    voiceName: this.ctx?.speech?.voiceName ?? "Aoede",
                  },
                },
              },
            },
            systemInstruction: {
              parts: [{ text: this.ctx?.systemInstruction ?? "" }],
            },
            tools: this.ctx?.tools ?? [],
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            sessionResumption: this.resumeHandle
              ? { handle: this.resumeHandle }
              : {},
            contextWindowCompression: {
              triggerTokens: 100000,
              slidingWindow: { targetTokens: 80000 },
            },
          },
        })
      );
    };
    ws.onclose = () => {
      // Any unexpected drop mid-call → try to resume with a fresh token.
      if (!this.stopped && this.status !== "off" && this.status !== "error")
        void this.reconnect();
    };
    ws.onerror = () => {
      if (this.status === "connecting" && !this.resumeHandle)
        this.fail("live_error");
    };
  }

  private async reconnect() {
    if (this.stopped || ++this.reconnects > 3) return this.fail("live_closed");
    this.setStatus("connecting");
    try {
      const res = await fetch("/api/live/token", { method: "POST" });
      if (!res.ok) throw new Error("token_failed");
      const { token } = (await res.json()) as { token: string };
      this.connect(token);
    } catch {
      this.fail("live_closed");
    }
  }

  private async onMessage(data: string | Blob) {
    let m: {
      setupComplete?: unknown;
      serverContent?: {
        modelTurn?: { parts?: { inlineData?: { data?: string } }[] };
        interrupted?: boolean;
        turnComplete?: boolean;
        inputTranscription?: { text?: string };
        outputTranscription?: { text?: string };
      };
      toolCall?: {
        functionCalls?: { id: string; name: string; args?: object }[];
      };
      sessionResumptionUpdate?: { newHandle?: string; resumable?: boolean };
      goAway?: unknown;
    };
    try {
      m = JSON.parse(typeof data === "string" ? data : await data.text());
    } catch {
      return;
    }

    if (m.setupComplete) {
      this.reconnects = 0;
      this.setStatus("listening");
      return;
    }
    if (m.sessionResumptionUpdate?.newHandle) {
      this.resumeHandle = m.sessionResumptionUpdate.newHandle;
      return;
    }
    if (m.goAway) {
      this.reconnect();
      return;
    }

    const sc = m.serverContent;
    if (sc) {
      if (sc.interrupted) {
        this.stopPlayback();
        this.setStatus("listening");
        return;
      }
      if (sc.inputTranscription?.text) {
        this.inputText += sc.inputTranscription.text;
        this.ev.onInterim(this.inputText);
      }
      if (sc.outputTranscription?.text) {
        this.setStatus("speaking");
      }
      const parts = sc.modelTurn?.parts ?? [];
      for (const p of parts) {
        if (p.inlineData?.data) this.playChunk(p.inlineData.data);
      }
      if (sc.turnComplete) {
        this.inputText = "";
        this.ev.onInterim("");
        if (this.status === "speaking") this.setStatus("listening");
      }
      return;
    }

    if (m.toolCall?.functionCalls) {
      const responses = await Promise.all(
        m.toolCall.functionCalls.map(async (fc) => {
          const res = await fetch("/api/live/tools", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              roomId: this.roomId,
              name: fc.name,
              args: fc.args ?? {},
            }),
          }).catch(() => null);
          const { result } = res
            ? ((await res.json().catch(() => ({}))) as { result?: string })
            : { result: "tool call failed" };
          return {
            id: fc.id,
            name: fc.name,
            response: { output: result ?? "" },
          };
        })
      );
      this.ws?.send(
        JSON.stringify({ toolResponse: { functionResponses: responses } })
      );
    }
  }

  // --- Audio playback: PCM16 @24kHz scheduled back-to-back ---------
  private playChunk(b64: string) {
    const pcm = base64ToPcm(b64);
    if (!this.playCtx) this.playCtx = new AudioContext({ sampleRate: 24000 });
    const ctx = this.playCtx;
    const buf = ctx.createBuffer(1, pcm.length, 24000);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 0x8000;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const start = Math.max(ctx.currentTime, this.nextPlay);
    src.start(start);
    this.nextPlay = start + buf.duration;
    if (this.status !== "speaking") this.setStatus("speaking");
  }

  private stopPlayback() {
    // Rebuild the context — cheapest way to drop every queued buffer.
    this.playCtx?.close().catch(() => {});
    this.playCtx = null;
    this.nextPlay = 0;
  }

  private fail(code: string) {
    this.teardown();
    this.status = "error";
    this.ev.onStatus("error");
    this.ev.onError(code);
  }

  private teardown() {
    this.stopped = true;
    this.ws?.close();
    this.ws = null;
    this.mic?.stop();
    this.mic = null;
    this.stopPlayback();
    this.ev.onInterim("");
  }

  stop() {
    this.teardown();
    if (this.status !== "off") {
      this.status = "off";
      this.ev.onStatus("off");
    }
  }
}
