import { EventEmitter } from "events";

/**
 * In-process room event bus. Anything that inserts a room message emits
 * here; the WebSocket server forwards to subscribed clients.
 */
const g = globalThis as { __itaskBus?: EventEmitter };
export const roomBus = g.__itaskBus ?? (g.__itaskBus = new EventEmitter());

export function emitRoomEvent(roomId: number, event: unknown) {
  roomBus.emit(`room:${roomId}`, event);
}

/** Notify subscribers that a room has new content worth re-fetching. */
export function notifyRoomChanged(roomId: number) {
  emitRoomEvent(roomId, { type: "refresh", roomId });
}
