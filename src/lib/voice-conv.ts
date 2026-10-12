import type { ChatMessage } from "./ai";

// Ephemeral voice-call transcripts. Voice turns are NOT written to
// room_messages — a call leaves no chat bubbles. This in-memory buffer
// carries the spoken exchange so the bot still sees the conversation
// context while the call is live (and briefly after, for "call back").
// Entries expire after a short idle window.

type VoiceTurn = { role: "user" | "assistant"; content: string };

const MAX_TURNS = 30; // ~15 exchanges — plenty for a phone-call context
const IDLE_TTL_MS = 30 * 60 * 1000;

const convs = new Map<string, { turns: VoiceTurn[]; touched: number }>();

function key(userId: number, roomId: number) {
  return `${userId}:${roomId}`;
}

export function voiceTurns(
  userId: number,
  roomId: number
): ChatMessage[] {
  const c = convs.get(key(userId, roomId));
  if (!c) return [];
  if (Date.now() - c.touched > IDLE_TTL_MS) {
    convs.delete(key(userId, roomId));
    return [];
  }
  return c.turns.map((t) => ({ role: t.role, content: t.content }));
}

export function pushVoiceTurn(
  userId: number,
  roomId: number,
  turn: VoiceTurn
) {
  const k = key(userId, roomId);
  let c = convs.get(k);
  if (!c || Date.now() - c.touched > IDLE_TTL_MS) {
    c = { turns: [], touched: 0 };
    convs.set(k, c);
  }
  c.turns.push(turn);
  if (c.turns.length > MAX_TURNS)
    c.turns = c.turns.slice(c.turns.length - MAX_TURNS);
  c.touched = Date.now();
}
