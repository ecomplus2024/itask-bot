import db from "./db";
import { chatOnce, ChatMessage, AIConfig } from "./ai";

/**
 * Context management for long-lived bot sessions, inspired by
 * Claude Code / OpenClaw compaction:
 * - older room messages are folded into a persisted summary
 *   (rooms.summary + rooms.summary_before_id)
 * - durable facts are flushed to bot_memories before compressing
 * - tool results from older rounds are pruned to placeholders
 * - provider context-overflow errors trigger compact + retry
 */

// Rough token estimator without a real tokenizer:
// CJK chars ~1 token each, everything else ~4 chars/token.
const CJK_RE =
  /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/g;
export function estimateTokens(text: string): number {
  const cjk = (text.match(CJK_RE) ?? []).length;
  return Math.ceil(cjk + (text.length - cjk) / 4);
}

export function estimateMessagesTokens(msgs: ChatMessage[]): number {
  let total = 0;
  for (const m of msgs) {
    total += estimateTokens(m.content ?? "") + 8;
    if (m.tool_calls) total += estimateTokens(JSON.stringify(m.tool_calls));
  }
  return total;
}

// History-token budget before we compact. Conservative default because
// provider context windows vary; override via env.
export const COMPACT_TOKEN_THRESHOLD = Number(
  process.env.ITASK_COMPACT_TOKENS ?? 24000
);
// Messages always kept verbatim after the summary boundary.
export const KEEP_RECENT = 14;

const OVERFLOW_RE =
  /context.{0,20}(length|window|overflow|exceeded)|request_too_large|input.{0,30}(too long|too large|exceeds)|maximum.{0,20}tokens/i;

export function isContextOverflowError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return OVERFLOW_RE.test(msg);
}

type RoomState = { summary: string; summary_before_id: number };

export function getRoomState(roomId: number): RoomState {
  const row = db
    .prepare("SELECT summary, summary_before_id FROM rooms WHERE id = ?")
    .get(roomId) as RoomState | undefined;
  return row ?? { summary: "", summary_before_id: 0 };
}

/**
 * Loads the messages the model should see: persisted summary first
 * (as a pseudo user message), then verbatim messages after the
 * compaction boundary.
 */
export function loadRoomContextMessages(
  roomId: number,
  botId: number,
  limit = 200
): ChatMessage[] {
  const { summary, summary_before_id } = getRoomState(roomId);
  const rows = (
    db
      .prepare(
        `SELECT id, kind, sender_id, sender_name, content FROM room_messages
         WHERE room_id = ? AND id > ? ORDER BY id DESC LIMIT ?`
      )
      .all(roomId, summary_before_id, limit) as {
      id: number;
      kind: string;
      sender_id: number;
      sender_name: string;
      content: string;
    }[]
  ).reverse();

  const msgs: ChatMessage[] = rows.map((m) =>
    m.kind === "bot" && m.sender_id === botId
      ? { role: "assistant", content: m.content }
      : { role: "user", content: `[${m.sender_name}]: ${m.content}` }
  );

  if (summary) {
    msgs.unshift({
      role: "user",
      content: `[Tóm tắt cuộc trò chuyện trước đó]: ${summary}`,
    });
  }
  return msgs;
}

/**
 * Compacts room history: summarizes everything before the last
 * KEEP_RECENT messages into rooms.summary, flushing durable facts
 * into bot_memories. Returns true if a compaction happened.
 */
export async function compactRoom(
  roomId: number,
  botId: number,
  config: AIConfig
): Promise<boolean> {
  const { summary, summary_before_id } = getRoomState(roomId);

  const rows = db
    .prepare(
      `SELECT id, sender_name, content FROM room_messages
       WHERE room_id = ? AND id > ? ORDER BY id`
    )
    .all(roomId, summary_before_id) as {
    id: number;
    sender_name: string;
    content: string;
  }[];

  const toCompact = rows.slice(0, Math.max(0, rows.length - KEEP_RECENT));
  if (!toCompact.length) return false;

  // Budget the summarizer input (~40K chars), favoring user messages
  // and the newest part of the range — same idea as OpenClaw.
  const INPUT_BUDGET = 40000;
  let input = "";
  for (const m of toCompact) {
    const line = `[${m.sender_name}]: ${m.content.slice(0, 2000)}\n`;
    if (input.length + line.length > INPUT_BUDGET) {
      input += `[${toCompact.length - input.split("\n").length + 1} tin nhắn còn lại được lược bỏ]\n`;
      break;
    }
    input += line;
  }

  const prompt =
    `You are compacting a long-running chat room's history. Reply with STRICT JSON only:\n` +
    `{"summary": "...", "facts": ["..."]}\n\n` +
    `- "summary": concise but complete recap of the conversation — user requests, ` +
    `decisions, corrections, open tasks, important context. Merge in the previous ` +
    `summary if present; do not invent content for omitted gaps. Write it in the ` +
    `same language the participants used.\n` +
    `- "facts": durable facts worth long-term memory (names, preferences, deadlines, ` +
    `decisions, company info). Empty array if none.\n\n` +
    `Previous summary:\n${summary || "(none)"}\n\nMessages to compact:\n${input}`;

  let parsed: { summary?: string; facts?: string[] } = {};
  try {
    const res = await chatOnce(
      [{ role: "user", content: prompt }],
      { ...config, systemPrompt: "You are a conversation summarizer." },
      []
    );
    const text = res.content ?? "";
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) parsed = JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    console.error("[compactRoom] summarization failed:", e);
  }

  const newSummary =
    (parsed.summary ?? "").trim() || summary || "(không tóm tắt được)";
  const boundaryId = toCompact[toCompact.length - 1].id;

  db.prepare("UPDATE rooms SET summary = ?, summary_before_id = ? WHERE id = ?").run(
    newSummary,
    boundaryId,
    roomId
  );

  // Memory flush: persist extracted facts (skip exact duplicates).
  if (botId && Array.isArray(parsed.facts)) {
    const ins = db.prepare(
      "INSERT INTO bot_memories (bot_id, content) VALUES (?, ?)"
    );
    const exists = db.prepare(
      "SELECT 1 FROM bot_memories WHERE bot_id = ? AND content = ?"
    );
    for (const fact of parsed.facts.slice(0, 10)) {
      const f = String(fact).trim();
      if (f && !exists.get(botId, f)) ins.run(botId, f);
    }
  }
  return true;
}

/**
 * Replaces tool results older than the most recent tool-call round
 * with a placeholder, keeping the message shape the API requires.
 */
export function pruneOldToolResults(msgs: ChatMessage[]): void {
  let lastToolIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "tool") {
      lastToolIdx = i;
      break;
    }
  }
  // Find the contiguous block of tool messages containing the last one
  // (one tool-call round may produce several consecutive tool messages).
  let roundStart = lastToolIdx;
  while (roundStart > 0 && msgs[roundStart - 1].role === "tool") roundStart--;

  for (let i = 0; i < roundStart; i++) {
    if (msgs[i].role === "tool") msgs[i].content = "[tool result omitted]";
  }
}
