import { WebSocketServer, WebSocket } from "ws";
import db from "./db";
import { roomBus } from "./bus";

const WS_PORT = Number(process.env.ITASK_WS_PORT || 3001);

/**
 * Embedded WebSocket server — runs inside the Next.js process, started
 * once from instrumentation.ts. Clients send {"subscribe": roomId}; the
 * server validates room ownership via the session cookie, then forwards
 * every room event to that socket.
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
    sock.on("message", (raw) => {
      try {
        const msg = JSON.parse(String(raw));
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
    sock.on("close", () => cleanup?.());
    sock.on("error", () => cleanup?.());
  });

  console.log(`[ws] listening on :${WS_PORT}`);
}
