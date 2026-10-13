import { WebSocketServer, WebSocket } from "ws";
import db from "./db";
import { roomBus } from "./bus";
import { resolveDeepgramKey, getUserSettings } from "./settings";
import { DEFAULT_DG_LANG } from "./voice-langs";

const WS_PORT = Number(process.env.ITASK_WS_PORT || 3001);

// Deepgram Nova-3 streaming STT for live voice chat. Audio flows
// client mic → this socket → Deepgram; transcripts flow back the same
// path. Vietnamese via language=vi; endpointing detects the end of a
// free-speech turn so no push-to-talk is needed.
const DG_BASE =
  "wss://api.deepgram.com/v1/listen" +
  "?model=nova-3&encoding=linear16&sample_rate=16000" +
  "&channels=1&interim_results=true&endpointing=500&vad_events=true" +
  "&smart_format=true&punctuate=true";

function startDeepgram(userId: number, sock: WebSocket): WebSocket | null {
  const key = resolveDeepgramKey(userId);
  const lang =
    getUserSettings(userId).voiceLanguage || DEFAULT_DG_LANG;
  const url = `${DG_BASE}&language=${encodeURIComponent(lang)}`;
  if (!key) {
    sock.send(
      JSON.stringify({
        type: "voice_error",
        message: "no_deepgram_key",
      })
    );
    return null;
  }
  const dg = new WebSocket(url, {
    headers: { Authorization: `Token ${key}` },
  });
  dg.on("message", (data) => {
    if (sock.readyState === sock.OPEN) sock.send(data.toString());
  });
  dg.on("error", (e) => {
    if (sock.readyState === sock.OPEN)
      sock.send(
        JSON.stringify({ type: "voice_error", message: String(e) })
      );
  });
  dg.on("close", (code, reason) => {
    if (sock.readyState === sock.OPEN)
      sock.send(
        JSON.stringify({
          type: "voice_closed",
          code,
          reason: reason.toString(),
        })
      );
  });
  // Deepgram idles out quiet sockets; ping it while we wait for speech.
  const ka = setInterval(() => {
    if (dg.readyState === dg.OPEN)
      dg.send(JSON.stringify({ type: "KeepAlive" }));
  }, 8000);
  dg.on("close", () => clearInterval(ka));
  return dg;
}

/**
 * Embedded WebSocket server — runs inside the Next.js process, started
 * once from instrumentation.ts. Two channels share one socket:
 * - {"subscribe": roomId}   → room refresh events
 * - {"type":"voice_start"}  → binary audio frames are proxied to
 *   Deepgram STT; its events stream back on this socket.
 * Auth is the session cookie, validated once at handshake.
 */
export function startWsServer() {
  const g = globalThis as { __itaskWs?: boolean };
  if (g.__itaskWs) return;
  g.__itaskWs = true;

  const wss = new WebSocketServer({ port: WS_PORT });

  wss.on("connection", (sock: WebSocket, req) => {
    const cookie = req.headers.cookie ?? "";
    const token = /itask_session=([^;\s]+)/.exec(cookie)?.[1];
    const user = token
      ? (db
          .prepare(
            `SELECT u.id FROM sessions s JOIN users u ON u.id = s.user_id
             WHERE s.token = ? AND s.expires_at > datetime('now')`
          )
          .get(token) as { id: number } | undefined)
      : undefined;
    if (!user) {
      sock.close();
      return;
    }

    let cleanup: (() => void) | null = null;
    let dg: WebSocket | null = null;
    const stopVoice = () => {
      if (dg) {
        try {
          dg.send(JSON.stringify({ type: "CloseStream" }));
        } catch {}
        try {
          dg.close();
        } catch {}
        dg = null;
      }
    };

    sock.on("message", (raw, isBinary) => {
      // Binary frames are mic audio → straight to Deepgram.
      if (isBinary) {
        if (dg?.readyState === WebSocket.OPEN) dg.send(raw);
        return;
      }
      try {
        const msg = JSON.parse(String(raw));
        if (msg.type === "voice_start") {
          stopVoice();
          dg = startDeepgram(user.id, sock);
          return;
        }
        if (msg.type === "voice_stop") {
          stopVoice();
          return;
        }
        const roomId = Number(msg.subscribe);
        if (!Number.isInteger(roomId)) return;
        const room = db
          .prepare("SELECT id FROM rooms WHERE id = ? AND user_id = ?")
          .get(roomId, user.id);
        if (!room) return;

        cleanup?.();
        const channel = `room:${roomId}`;
        const handler = (e: unknown) => {
          if (sock.readyState === sock.OPEN) sock.send(JSON.stringify(e));
        };
        roomBus.on(channel, handler);
        cleanup = () => roomBus.off(channel, handler);
        sock.send(JSON.stringify({ type: "subscribed", roomId }));
      } catch {
        // malformed frame — ignore
      }
    });
    sock.on("close", () => {
      cleanup?.();
      stopVoice();
    });
    sock.on("error", () => {
      cleanup?.();
      stopVoice();
    });
  });

  console.log(`[ws] listening on :${WS_PORT}`);
}
