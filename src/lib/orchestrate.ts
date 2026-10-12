import db from "./db";
import {
  Bot,
  getBotRecentLogs,
  getBotTopicNotes,
  getRoomBots,
  logBotActivity,
  resolveBotConfig,
  resolveResponders,
} from "./bots";
import { getBuiltinTools } from "./builtin-tools";
import { getMcpTools, OpenAITool } from "./mcp";
import { chatOnce, ChatMessage } from "./ai";
import { searchChunks } from "./knowledge";
import { markBotRunning, unmarkBotRunning } from "./status";
import { notifyRoomChanged } from "./bus";
import {
  COMPACT_TOKEN_THRESHOLD,
  compactRoom,
  estimateMessagesTokens,
  isContextOverflowError,
  loadRoomContextMessages,
  pruneOldToolResults,
} from "./context";
import { jevEval, resolveJevKey, JevQuestion } from "./jev";

const MAX_BOT_TURNS = 6;
const HISTORY_LIMIT = 40;

// Removes emoji / decorative pictographs from bot replies, then tidies
// up the whitespace they leave behind.
const EMOJI_RE =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0E}\u{FE0F}\u{200D}]/gu;
function stripEmoji(text: string): string {
  return text
    .replace(EMOJI_RE, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type RoomMessage = {
  id: number;
  kind: string;
  sender_id: number;
  sender_name: string;
  content: string;
  created_at: string;
};

export type RoomEvent =
  | { type: "bot_start"; bot: { id: number; name: string; avatar: string } }
  | { type: "bot_silent"; botId: number }
  | { type: "delta"; botId: number; text: string }
  | { type: "message"; message: RoomMessage }
  | { type: "done" };

export function loadRoomMessages(
  roomId: number,
  limit = HISTORY_LIMIT
): RoomMessage[] {
  return (
    db
      .prepare(
        `SELECT id, kind, sender_id, sender_name, content, created_at FROM room_messages
         WHERE room_id = ? ORDER BY id DESC LIMIT ?`
      )
      .all(roomId, limit) as RoomMessage[]
  ).reverse();
}

// Deterministic fix for a stubborn model habit: trailing "Anh muốn em
// đi sâu vào phần nào không ạ (A, B, hay C)?" offers. The question is
// deleted; when it carries a parenthesized option list, the options are
// converted into [[SUGGEST: ...]] chips instead of an open question.
const TRAILING_OFFER_RE =
  /[^?\n]*?(?:muốn|cần)\s+(?:em|mình|bạn|anh|chị)[^?\n]*\?\s*$|[^?\n]*?(?:would you like|want me to|do you want me|shall i)[^?\n]*\?\s*$/i;

function convertTrailingOffer(content: string): string {
  const m = TRAILING_OFFER_RE.exec(content);
  if (!m) return content;

  const question = m[0];
  // Options look like "(đơn giao thất bại, ads, hay tồn kho)".
  const pm = /\(([^()]*(?:[,，;]|\bhay\b|\bhoặc\b|\bor\b)[^()]*)\)/.exec(
    question
  );
  let suggestions: string[] = [];
  if (pm) {
    suggestions = pm[1]
      .split(/[,，;]|\s+hay\s+|\s+hoặc\s+|\s+or\s+/i)
      .map((s) =>
        s
          .trim()
          .replace(/^(?:và|and)\s+/i, "")
          .replace(/[.…]+$/, "")
      )
      .filter((s) => s.length > 1 && s.length <= 60)
      .slice(0, 4);
  }

  let out = content.slice(0, m.index).trimEnd();
  if (suggestions.length >= 2) {
    out += `\n\n[[SUGGEST: ${suggestions.join(" | ")}]]`;
  }
  return out;
}

function saveBotMessage(roomId: number, bot: Bot, content: string) {
  content = convertTrailingOffer(content);
  // Bots sometimes paste the same /files/N link several times — keep the
  // first occurrence of each file id and drop repeats.
  const seen = new Set<string>();
  content = content
    .replace(/\[([^\]]*)\]\((\/files\/\d+)\)/g, (m, label, url) =>
      seen.has(url) ? "" : (seen.add(url), m)
    )
    .replace(/\n{3,}/g, "\n\n");
  const r = db
    .prepare(
      `INSERT INTO room_messages (room_id, kind, sender_id, sender_name, content)
       VALUES (?, 'bot', ?, ?, ?)`
    )
    .run(roomId, bot.id, bot.name, content);
  db.prepare("UPDATE rooms SET updated_at = datetime('now') WHERE id = ?").run(
    roomId
  );
  notifyRoomChanged(roomId);
  return db
    .prepare(
      "SELECT id, kind, sender_id, sender_name, content, created_at FROM room_messages WHERE id = ?"
    )
    .get(r.lastInsertRowid) as RoomMessage;
}

// Records a named prompt section (id/label/text) and appends it to the
// system prompt — so the "what the model sees" preview shows the same
// bytes the model receives, split into inspectable parts.
function addPart(
  config: ReturnType<typeof resolveBotConfig>,
  id: string,
  label: string,
  text: string
) {
  config.systemPrompt += text;
  (config.promptParts ??= []).push({ id, label, text });
}

type PreparedTurn = {
  config: ReturnType<typeof resolveBotConfig>;
  roomName: string;
  isBotDM: boolean;
  history: ChatMessage[];
  lastUserMsg: string | null | undefined;
  builtin: ReturnType<typeof getBuiltinTools>;
  tools: OpenAITool[];
  execute: (name: string, args: Record<string, unknown>) => Promise<string>;
};

/**
 * Assembles everything a bot turn needs: the full system prompt (as named
 * sections), room context messages, and the merged tool set. Shared by
 * runBot and the prompt-preview API. `preview: true` skips side effects
 * (context compaction writes) and tool/room writes.
 */
export async function prepareBotTurn(
  bot: Bot,
  roomId: number,
  userId: number,
  hiddenInstruction?: string,
  collabDepth = 0,
  opts?: { preview?: boolean }
): Promise<PreparedTurn> {
  const config = resolveBotConfig(bot);

  // Tell the bot exactly who shares this room, so it never wrongly
  // claims a member "is not in the room".
  const roomInfo = db
    .prepare("SELECT name, kind FROM rooms WHERE id = ?")
    .get(roomId) as { name: string | null; kind?: string } | undefined;
  const isBotDM = roomInfo?.kind === "bot_dm";
  const memberRows = db
    .prepare(
      `SELECT rm.kind, COALESCE(b.name, u.name) AS name
       FROM room_members rm
       LEFT JOIN bots b ON rm.kind = 'bot' AND b.id = rm.ref_id
       LEFT JOIN users u ON rm.kind = 'user' AND u.id = rm.ref_id
       WHERE rm.room_id = ?`
    )
    .all(roomId) as { kind: string; name: string | null }[];
  const roster = memberRows
    .map(
      (m) =>
        `${m.name ?? "?"}${m.kind === "bot" && m.name === bot.name ? " (you)" : ""}` +
        `${m.kind === "user" ? " (human)" : ""}`
    )
    .join(", ");
  addPart(
    config,
    "room",
    "Room & members",
    `\n\nYou are in room "${roomInfo?.name ?? roomId}". Members present: ${roster}.`
  );

  // Colleague directory + reachability map: for each colleague, which
  // shared rooms can reach them. A colleague with no shared room is ONLY
  // reachable via itask__ask_bot — broadcasting elsewhere can't get them.
  const colleagues = db
    .prepare(
      "SELECT id, name, role FROM bots WHERE user_id = ? AND id != ? ORDER BY id"
    )
    .all(userId, bot.id) as { id: number; name: string; role: string | null }[];
  if (colleagues.length) {
    const sharedStmt = db.prepare(
      `SELECT r.id, r.name FROM rooms r
       JOIN room_members a ON a.room_id = r.id AND a.kind = 'bot' AND a.ref_id = ?
       JOIN room_members b ON b.room_id = r.id AND b.kind = 'bot' AND b.ref_id = ?
       WHERE r.user_id = ? AND r.id != ? AND r.kind != 'bot_dm'`
    );
    const directory = colleagues
      .map((c) => {
        const shared = (
          sharedStmt.all(bot.id, c.id, userId, roomId) as {
            id: number;
            name: string | null;
          }[]
        ).map((r) => `#${r.id} "${r.name ?? "chat"}"`);
        return (
          `${c.name}${c.role ? ` — ${c.role}` : ""}` +
          (shared.length
            ? ` [shared rooms: ${shared.join(", ")}]`
            : " [no shared room — private DM only]")
        );
      })
      .join("; ");

    addPart(
      config,
      "colleagues",
      "Colleagues & reachability",
      `\n\n## Reaching colleagues\n${directory}\n` +
      `Choose the channel by what you need:\n` +
      `- Need their ANSWER to finish YOUR task (data, file, analysis) → ` +
      `itask__ask_bot: private, they reply directly to you. This is also ` +
      `the ONLY way to reach a colleague with no shared room.\n` +
      `- Hand work off openly in THIS room, or the exchange belongs in ` +
      `this conversation → @mention them in your reply.\n` +
      `- Delegate work to a GROUP or a specialist in another room, and you ` +
      `do NOT need the result right now → itask__send_room_message to that ` +
      `room with @mention. Their reply stays in that room.\n` +
      `Reaching a colleague is a normal tool action you perform NOW in ` +
      `this turn — NEVER schedule it for later just because it involves ` +
      `another bot. Scheduling is only for work the user wants at a ` +
      `future time. Keep private queries out of group rooms; keep things ` +
      `the user should see out of DMs.`
    );
  }

  // Bot↔bot DM: the reply IS the work product handed to the colleague —
  // the usual ~4-line chat limit would truncate it, so completeness wins.
  if (isBotDM) {
    addPart(
      config,
      "dm",
      "Private channel note",
      `\n\nThis is your private channel with a colleague. They contacted ` +
        `you for help — give the FULL answer or work result they need ` +
        `(data, files, analysis), not a 4-line summary. Be complete but ` +
        `focused; skip small talk.`
    );
  }

  // List the OTHER rooms this bot belongs to, with ids and members, so
  // it can resolve references like "nhóm công việc" and delegate work
  // there via itask__send_room_message.
  const otherRooms = db
    .prepare(
      `SELECT r.id, r.name FROM rooms r
       JOIN room_members rm ON rm.room_id = r.id
       WHERE rm.kind = 'bot' AND rm.ref_id = ? AND r.user_id = ? AND r.id != ?
         AND r.kind != 'bot_dm'`
    )
    .all(bot.id, userId, roomId) as { id: number; name: string | null }[];
  if (otherRooms.length) {
    const desc = otherRooms
      .map((r) => {
        const ms = (
          db
            .prepare(
              `SELECT COALESCE(b.name, u.name) AS name FROM room_members rm
               LEFT JOIN bots b ON rm.kind = 'bot' AND b.id = rm.ref_id
               LEFT JOIN users u ON rm.kind = 'user' AND u.id = rm.ref_id
               WHERE rm.room_id = ?`
            )
            .all(r.id) as { name: string | null }[]
        )
          .map((m) => m.name ?? "?")
          .join(", ");
        return `#${r.id} "${r.name ?? "chat"}" (members: ${ms})`;
      })
      .join("; ");
    addPart(
      config,
      "other_rooms",
      "Other rooms",
      `\n\nOther rooms you belong to: ${desc}. ` +
        `To delegate work to bots in one of those rooms, call ` +
        `itask__send_room_message with that room's id and @mention the bots ` +
        `you want to act.`
    );
  }

  // Compact when the projected history exceeds the token budget,
  // then reload the context (summary + verbatim tail).
  if (
    !opts?.preview &&
    estimateMessagesTokens(loadRoomContextMessages(roomId, bot.id)) >
      COMPACT_TOKEN_THRESHOLD
  ) {
    await compactRoom(roomId, bot.id, config);
  }
  const history = loadRoomContextMessages(roomId, bot.id);

  // Knowledge base retrieval (RAG): pull chunks relevant to the
  // latest user message (or the scheduled instruction) into the
  // system prompt.
  const lastUserMsg =
    hiddenInstruction ??
    [...history].reverse().find((m) => m.role === "user")?.content;
  if (lastUserMsg) {
    const hits = searchChunks(bot.id, lastUserMsg, 5);
    if (hits.length) {
      addPart(
        config,
        "knowledge",
        "Knowledge base",
        "\n\n## Knowledge base (relevant excerpts)\n" +
          hits.map((h) => `---\n${h}`).join("\n")
      );
    }

    // Topic notes relevant to this message + the last couple of days of
    // the bot's work log — structured memory beyond flat core facts.
    const notes = getBotTopicNotes(bot.id, lastUserMsg);
    if (notes.length) {
      addPart(
        config,
        "notes",
        "Topic notes",
        "\n\n## Topic notes\n" + notes.map((n) => `- ${n}`).join("\n")
      );
    }
  }
  const logs = getBotRecentLogs(bot.id);
  if (logs.length) {
    addPart(
      config,
      "log",
      "Recent activity log",
      "\n\n## Recent activity (your work log)\n" +
        logs.map((l) => `- ${l}`).join("\n")
    );
  }

  const builtin = getBuiltinTools(userId, bot.id, roomId, collabDepth);
  // Preview builds the prompt only — skip connecting to MCP servers.
  const mcp = opts?.preview
    ? { tools: [] as OpenAITool[], execute: async () => "" }
    : await getMcpTools(userId);
  const tools: OpenAITool[] = [...builtin.tools, ...mcp.tools];
  const execute = (name: string, args: Record<string, unknown>) =>
    name.startsWith("itask__")
      ? builtin.execute(name, args)
      : mcp.execute(name, args);

  addPart(
    config,
    "tools",
    "Tools",
    "\n\nYou have tools available: itask__* for managing your memory, skills, " +
      "MCP servers, your own profile (itask__update_profile), your schedule, " +
      "messaging other rooms, and creating files for the user " +
      "(itask__create_file — csv/xlsx/html/md/txt; use it whenever the user " +
      "wants a report, export or document), plus tools from your connected " +
      "MCP servers."
  );

  return {
    config,
    roomName: roomInfo?.name ?? `room ${roomId}`,
    isBotDM,
    history,
    lastUserMsg,
    builtin,
    tools,
    execute,
  };
}

/**
 * Runs one bot's turn. Yields delta events, returns final text.
 */
async function* runBot(
  bot: Bot,
  roomId: number,
  userId: number,
  allowSilent = true,
  hiddenInstruction?: string,
  collabDepth = 0
): AsyncGenerator<RoomEvent, string> {
  const {
    config,
    roomName,
    isBotDM,
    history,
    lastUserMsg,
    builtin,
    tools,
    execute,
  } = await prepareBotTurn(bot, roomId, userId, hiddenInstruction, collabDepth);

  // Fast acknowledgment: when the request clearly needs processing time
  // (queries, tools, contacting colleagues), post a natural one-line ack
  // first — like a real colleague saying "em kiểm tra ngay ạ" — then do
  // the actual work. Skipped for scheduled/proactive runs and bot DMs.
  // When Jev is configured it makes the needs-work decision (fast typed
  // answer); without Jev, quickAck's own LLM call decides.
  if (!hiddenInstruction && !isBotDM && lastUserMsg) {
    const needsWork = await jevNeedsWork(userId, lastUserMsg);
    const ack =
      needsWork === false
        ? null
        : await quickAck(bot, config, lastUserMsg, needsWork === true);
    if (ack) {
      const saved = saveBotMessage(roomId, bot, ack);
      yield { type: "message", message: saved };
    }
  }

  let msgs: ChatMessage[] = [...history];
  // A hidden instruction (e.g. a scheduled task) is injected into the
  // model context only — it never becomes a room message.
  if (hiddenInstruction) {
    // Caller supplies the prefix — e.g. "[Scheduled task]" or
    // "[Proactive check-in]".
    msgs.push({ role: "user", content: hiddenInstruction });
  }
  let answer: string | null = null;
  let overflowRetried = false;
  const calledTools = new Set<string>();

  async function runRounds(maxRounds: number): Promise<string | null> {
    for (let round = 0; round < maxRounds; round++) {
      pruneOldToolResults(msgs);
      let msg: ChatMessage;
      try {
        msg = await chatOnce(msgs, config, tools);
      } catch (e) {
        // Overflow recovery: compact the room, rebuild context, retry once
        if (isContextOverflowError(e) && !overflowRetried) {
          overflowRetried = true;
          await compactRoom(roomId, bot.id, config);
          msgs = loadRoomContextMessages(roomId, bot.id);
          round--;
          continue;
        }
        throw e;
      }
      if (!msg.tool_calls?.length) return msg.content;
      msgs.push(msg);
      for (const tc of msg.tool_calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments || "{}");
        } catch {
          // keep empty
        }
        calledTools.add(tc.function.name);
        console.log(`[runBot] ${bot.name} → ${tc.function.name}`);
        const result = await execute(tc.function.name, args);
        msgs.push({
          role: "tool",
          tool_call_id: tc.id,
          content: result.slice(0, 8000),
        });
      }
    }
    return null;
  }

  try {
    answer = await runRounds(12);

    // Ran out of tool-call rounds without a final answer — force a
    // plain-text wrap-up instead of posting an empty "…" reply.
    if (!answer) {
      msgs.push({
        role: "user",
        content:
          "You used all tool-call rounds. Stop calling tools now — " +
          "summarize briefly what you found or did in one short message.",
      });
      try {
        const res = await chatOnce(msgs, config, []);
        answer = res.content;
      } catch {
        // leave null → the caller's error path handles it
      }
    }

    // Action verification: a small AI pass decides whether required
    // actions (schedule, memory) were actually performed or only
    // acknowledged in words.
    if (answer && !answer.startsWith("[Error")) {
      const triggerText = hiddenInstruction
        ? ""
        : ([...msgs]
            .reverse()
            .find(
              (m) =>
                m.role === "user" &&
                !(m.content ?? "").startsWith("[Scheduled") &&
                !(m.content ?? "").startsWith("[Proactive")
            )?.content ?? "");
      // Up to 2 rounds: models sometimes acknowledge the reminder and
      // still skip the tool. Each nudge carries the current time so
      // run_at computations stay correct.
      for (let attempt = 0; attempt < 2; attempt++) {
        const missing = await verifyActions(
          triggerText,
          answer,
          calledTools,
          config,
          userId
        );
        if (!missing.length) break;
        console.log(`[runBot] ${bot.name} missing actions:`, missing);
        msgs.push({ role: "assistant", content: answer });
        msgs.push({
          role: "user",
          content:
            `Current date/time: ${new Date().toLocaleString("sv-SE", { timeZone: "Asia/Ho_Chi_Minh" })} (Asia/Ho_Chi_Minh).\n` +
            "You acknowledged work in words but never called the required " +
            "tool(s). Call each of these now for real — use run_at as an " +
            "ISO datetime computed from the current time above — then " +
            "confirm briefly (confirmation only, no data/result dump):\n- " +
            missing.join("\n- "),
        });
        const retry = await runRounds(4);
        if (retry) answer = retry;
      }
    }
  } catch (e) {
    const cause =
      e instanceof Error && e.cause instanceof Error
        ? ` | cause: ${e.cause.message} ${(e.cause as NodeJS.ErrnoException).code ?? ""}`
        : "";
    console.error("[runBot] error:", e, (e as Error)?.cause);
    answer = `[Error: ${e instanceof Error ? e.message : "AI request failed"}${cause}]`;
  }

  // Style enforcement: some models ignore the length rule — condense
  // oversized replies into a short natural chat message.
  if (answer && !answer.startsWith("[Error") && answer.length > 1000) {
    try {
      const res = await chatOnce(
        [
          {
            role: "user",
            content:
              `Rewrite the following as a short, natural chat message in the ` +
              `same language: max ~4 short lines, keep only the essential ` +
              `facts, drop headings, lecture format, and any trailing ` +
              `follow-up question or offer of more detail. Keep a final ` +
              `[[SUGGEST: ...]] line intact if present. Output the ` +
              `rewritten message only.\n\n${answer}`,
          },
        ],
        { ...config, systemPrompt: "You condense text." },
        []
      );
      if (res.content?.trim()) answer = res.content.trim();
    } catch {
      // keep the long answer if condensation fails
    }
  }

  let text = stripEmoji(answer ?? "…") || "…";

  // Attach links to files the bot created during this run — even when the
  // model forgot to mention them, or (rarely) went silent after working.
  if (builtin.createdFiles.length) {
    const links = builtin.createdFiles
      .map((f) => `[${f.name}](${f.url})`)
      .join("\n\n");
    text = SILENT_RE.test(text) ? links : `${text}\n\n${links}`;
  }

  // One-on-one chats must never go silent — nudge the model once.
  if (!allowSilent && SILENT_RE.test(text)) {
    try {
      const res = await chatOnce(
        [
          ...msgs,
          {
            role: "user",
            content:
              "This is a one-on-one chat — you MUST reply to the user's " +
              "last message. Do not output [[SILENT]].",
          },
        ],
        config,
        tools
      );
      if (res.content?.trim() && !SILENT_RE.test(res.content)) {
        text = stripEmoji(res.content) || "…";
      }
    } catch {
      // keep silent result
    }
  }

  if (SILENT_RE.test(text)) return text;

  // Persist BEFORE streaming deltas so a client disconnect can never
  // lose a completed reply.
  const saved = saveBotMessage(roomId, bot, text);

  // Daily work log — the bot's own "what I did" record (kind='log').
  logBotActivity(bot.id, roomName, lastUserMsg ?? "", text);

  // Emit in slices for a streaming feel
  for (let i = 0; i < text.length; i += 24) {
    yield { type: "delta", botId: bot.id, text: text.slice(i, i + 24) };
  }
  yield { type: "message", message: saved };
  return text;
}

/**
 * Runs a single bot turn (used by the scheduler). Drains deltas
 * and saves the bot's reply to the room.
 */
export async function runBotInstruction(
  roomId: number,
  userId: number,
  bot: Bot,
  instruction?: string,
  allowSilent = false,
  collabDepth = 0
): Promise<string> {
  // runBot persists the reply itself; scheduled tasks must produce output,
  // so silence is not allowed there — proactive check-ins may stay silent.
  // The instruction is context-only: nothing is written to room_messages
  // except the bot's reply.
  markBotRunning(bot.id);
  try {
    const gen = runBot(
      bot,
      roomId,
      userId,
      allowSilent,
      instruction,
      collabDepth
    );
    let content = "";
    while (true) {
      const { value, done } = await gen.next();
      if (done) {
        content = value;
        break;
      }
    }
    return content;
  } finally {
    unmarkBotRunning(bot.id);
  }
}

/**
 * Runs the room turn: bots mentioned in the triggering message respond,
 * then bots mentioned inside bot replies respond too (bounded).
 */
// Bot decided it has nothing to add to the group conversation.
const SILENT_RE = /^\s*\[{1,2}\s*SILENT\s*\]{1,2}/i;

/**
 * One cheap triage call: decides whether the user request needs real work.
 * Returns a short natural ack line to post immediately, or null when the
 * bot can answer right away (greeting, simple question) and no ack is
 * needed. Never throws — a failed triage just means no ack message.
 */
/**
 * Jev fast path for the ack decision: "does this message need real work?"
 * Returns true/false, or null when Jev isn't configured or failed —
 * callers then fall back to quickAck's own LLM judgment.
 */
async function jevNeedsWork(
  userId: number,
  text: string
): Promise<boolean | null> {
  const answers = await jevEval(
    userId,
    `Chat message: "${text.slice(0, 2000)}"`,
    {
      needs_work: {
        type: "noul",
        instructions:
          "Handling this message requires real work or processing time " +
          "(data queries, tools, contacting people, research, analysis, " +
          "creating files, multi-step answers) — it cannot be answered " +
          "instantly like a greeting, thanks, or trivial small talk",
      },
    }
  );
  const v = answers?.needs_work?.noul;
  return v == null ? null : v > 0.5;
}

/**
 * Jev group routing: decides which bots a message concerns, given the
 * last 10 room messages and every bot's role. Returns the relevant bots,
 * or null when Jev isn't configured/failed — callers fall back to
 * running everyone (bots self-decide with [[SILENT]]).
 */
async function jevRouteBots(
  roomId: number,
  userId: number,
  roomBots: Bot[]
): Promise<Bot[] | null> {
  if (!resolveJevKey(userId)) return null;
  const history = loadRoomMessages(roomId, 10);
  const state =
    "Group members and their roles:\n" +
    roomBots
      .map((b) => `- ${b.name}${b.role ? `: ${b.role}` : ""}`)
      .join("\n") +
    "\n\nRecent messages (latest last):\n" +
    history
      .map((m) => `[${m.sender_name}]: ${m.content.slice(0, 300)}`)
      .join("\n");
  const questions = Object.fromEntries(
    roomBots.map((b) => [
      `bot_${b.id}`,
      {
        type: "noul" as const,
        instructions:
          `The latest message concerns ${b.name} or needs ` +
          `${b.name}'s expertise${b.role ? ` (${b.role})` : ""} — ` +
          `they should respond or participate`,
      },
    ])
  );
  const answers = await jevEval(userId, state, questions);
  if (!answers) return null;
  const picked = roomBots.filter(
    (b) => (answers[`bot_${b.id}`]?.noul ?? 0) > 0.5
  );
  console.log(
    "[jev] room route:",
    roomBots.map(
      (b) => `${b.name}=${(answers[`bot_${b.id}`]?.noul ?? 0).toFixed(2)}`
    ).join(", ")
  );
  return picked;
}

async function quickAck(
  bot: Bot,
  config: ReturnType<typeof resolveBotConfig>,
  userText: string,
  force = false
): Promise<string | null> {
  try {
    const res = await chatOnce(
      [
        {
          role: "user",
          content:
            `${bot.name} — a colleague just sent you this chat message:\n` +
            `"${userText.slice(0, 500)}"\n\n` +
            (force
              ? `Handling it needs real work or time — reply with ONE ` +
                `short natural acknowledgment in the same language the ` +
                `message uses, like a human colleague ("Dạ em kiểm tra ` +
                `ngay ạ"). Acknowledge only: no answers, no questions, ` +
                `no details.`
              : `If handling it needs real work or time (data queries, tools, ` +
                `contacting people, research, analysis, creating files) → reply ` +
                `with ONE short natural acknowledgment in the same language the ` +
                `message uses — like a human colleague ("Dạ em kiểm tra ngay ạ"). ` +
                `Acknowledge only: no answers, no questions, no details.\n` +
                `If you could answer it right away with no work at all ` +
                `(greeting, thanks, trivial small talk) → reply with exactly ` +
                `[[NOW]] and nothing else.`),
        },
      ],
      { ...config, systemPrompt: "You write one-line chat acknowledgments." },
      []
    );
    const t = (res.content ?? "").trim();
    if (!t || t.includes("[[NOW]]") || SILENT_RE.test(t)) return null;
    return stripEmoji(t).split("\n")[0].slice(0, 200) || null;
  } catch {
    return null;
  }
}

/**
 * AI-based action verification. Instead of pattern-matching keywords, a
 * small model call inspects the user's trigger + the bot's reply + the
 * tools actually called, and reports which required actions are missing.
 */
async function verifyActions(
  triggerText: string,
  reply: string,
  calledTools: Set<string>,
  config: Parameters<typeof chatOnce>[1],
  userId: number
): Promise<string[]> {
  const schedTools = [
    "itask__schedule_task",
    "itask__update_task",
    "itask__cancel_task",
  ];
  const scheduleCalled = schedTools.some((t) => calledTools.has(t));
  const rememberCalled = calledTools.has("itask__remember");
  const delegateCalled =
    calledTools.has("itask__ask_bot") ||
    calledTools.has("itask__send_room_message");

  // Nothing to verify when all concerns are already satisfied.
  if (scheduleCalled && rememberCalled && delegateCalled) return [];

  const state =
    `USER REQUEST: ${triggerText || "(scheduled run / unknown)"}\n\n` +
    `ASSISTANT REPLY: ${reply}\n\n` +
    `TOOLS ACTUALLY CALLED: ${[...calledTools].join(", ") || "none"}`;

  type Flag = "schedule" | "remember" | "delegate";
  let flags: Set<Flag> | null = null;

  // Jev fast path: three typed noul questions in ONE call replace the
  // JSON-generating LLM verifier — typed answers, no parsing, much faster.
  // Any failure falls through to the LLM path below.
  if (resolveJevKey(userId)) {
    const questions: Record<string, JevQuestion> = {};
    if (!scheduleCalled)
      questions.schedule = {
        type: "noul",
        instructions:
          "The user asked for work to happen LATER, at a specific future " +
          "time, or PERIODICALLY (e.g. 'in N minutes', 'tomorrow', 'every " +
          "morning', 'remind me', 'báo cáo lại sau'), and no scheduling " +
          "tool was called — the job belongs to a future scheduled run, " +
          "not to the reply",
      };
    if (!rememberCalled)
      questions.remember = {
        type: "noul",
        instructions:
          "The assistant's reply claims it noted/saved/remembered or will " +
          "remember something, but no memory tool was called",
      };
    if (!delegateCalled)
      questions.delegate = {
        type: "noul",
        instructions:
          "The assistant's reply says it asked/contacted/relayed to " +
          "another bot, delegated work, or promises to report a " +
          "colleague's answer, but no colleague-contact tool was called " +
          "(a written @mention in the reply does not count)",
      };
    const answers = await jevEval(userId, state, questions);
    if (answers) {
      flags = new Set(
        (Object.keys(questions) as Flag[]).filter(
          (k) => (answers[k]?.noul ?? 0) > 0.5
        )
      );
      if (flags.size)
        console.log("[jev] verifyActions missing:", [...flags].join(", "));
    }
  }

  if (!flags) {
    flags = new Set();
    try {
      const res = await chatOnce(
        [
          {
            role: "user",
            content:
              `You verify whether an assistant actually performed required ` +
              `actions or only claimed them in words.\n\n` +
              `${state}\n\n` +
              `Rules:\n` +
              `- If the user asked for work to happen LATER, at a specific ` +
              `future time, or PERIODICALLY (e.g. "in N minutes", "tomorrow", ` +
              `"every morning", "remind me", "báo cáo lại sau"), a scheduling ` +
              `tool MUST have been called. The job belongs to the future run, ` +
              `not to the reply. Note: a reply that merely confirms a schedule ` +
              `it just created is fine.\n` +
              `- If the assistant claims it noted/saved/remembered/will ` +
              `remember something, itask__remember MUST have been called.\n` +
              `- If the assistant says it asked/contacted/relayed to another ` +
              `bot, delegated work, or promises to report a colleague's ` +
              `answer, a contact tool (itask__ask_bot or ` +
              `itask__send_room_message) MUST have been called. An @mention ` +
              `inside the reply text does NOT count — only the tools reach ` +
              `the colleague.\n` +
              `- If the user only shared information and the assistant merely ` +
              `acknowledged receipt (no claim to store or to contact anyone), ` +
              `no tool is required.\n` +
              `Reply with a JSON object only, e.g. ` +
              `{"missing": []} or {"missing": ["schedule", "remember", "delegate"]}.`,
          },
        ],
        { ...config, systemPrompt: "You are a strict JSON verifier." },
        []
      );
      const text = res.content ?? "";
      const json = JSON.parse(
        text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1) || "{}"
      ) as { missing?: string[] };
      for (const m of json.missing ?? [])
        if (m === "schedule" || m === "remember" || m === "delegate")
          flags.add(m);
    } catch {
      return [];
    }
  }

  const missing: string[] = [];
  if (flags.has("schedule") && !scheduleCalled) {
    missing.push(
      "a scheduling tool (itask__schedule_task / itask__update_task / itask__cancel_task — call itask__list_tasks first if you need the task id) — the user asked for work to happen LATER or PERIODICALLY, but nothing was scheduled. Schedule the WHOLE job for that future time and reply with ONLY a brief confirmation — do NOT include the result/data itself."
    );
  }
  if (flags.has("remember") && !rememberCalled) {
    missing.push(
      "itask__remember — you said you noted/remembered something but nothing was stored"
    );
  }
  if (flags.has("delegate") && !delegateCalled) {
    missing.push(
      "a colleague-contact tool — you said you would ask/notify another bot but never reached them. Use itask__ask_bot for a private question whose answer you need, or itask__send_room_message to delegate into a shared room (writing @Name in your reply does NOT contact them)."
    );
  }
  return missing;
}

// Bots evaluate a message concurrently like real colleagues — everyone
// reads it at the same time. Capped to be gentle on shared AI gateways.
const PARALLEL_LIMIT = 3;

export async function* orchestrate(
  roomId: number,
  userId: number,
  triggerContent: string
): AsyncGenerator<RoomEvent> {
  const roomBots = getRoomBots(roomId, userId);
  // Everyone in the room listens. Mentioned bots go first; the rest may
  // still chime in like real colleagues (or stay silent).
  const mentioned = resolveResponders(triggerContent, roomBots);
  let queue: Bot[] = [
    ...mentioned,
    ...roomBots.filter((b) => !mentioned.some((m) => m.id === b.id)),
  ];
  // Jev routing (group rooms, no explicit mentions): given the last 10
  // messages and each bot's role, Jev decides which bots the message
  // actually concerns — the rest don't even wake up, saving their turns.
  // No key/failure → everyone listens as before. A "nobody" verdict is
  // treated as unreliable and also falls back to everyone.
  if (roomBots.length > 1 && mentioned.length === 0) {
    const relevant = await jevRouteBots(roomId, userId, roomBots);
    if (relevant?.length) queue = relevant;
  }
  const responded = new Set<number>();
  let turns = 0;

  while (queue.length && turns < MAX_BOT_TURNS) {
    // Grab the next batch of bots to run in parallel.
    const batch: Bot[] = [];
    while (
      queue.length &&
      batch.length < PARALLEL_LIMIT &&
      turns + batch.length < MAX_BOT_TURNS
    ) {
      const bot = queue.shift()!;
      if (responded.has(bot.id)) continue;
      responded.add(bot.id);
      batch.push(bot);
    }
    if (!batch.length) continue;
    turns += batch.length;

    // Shared event channel: workers push events, we yield them in order.
    const pending: (RoomEvent | { type: "__batch_done" })[] = [];
    let notify: (() => void) | null = null;
    const push = (ev: RoomEvent | { type: "__batch_done" }) => {
      pending.push(ev);
      notify?.();
    };
    const waitForEvent = () =>
      new Promise<void>((resolve) => {
        notify = resolve;
      });

    const results: { bot: Bot; content: string }[] = [];
    const workers = batch.map(async (bot) => {
      push({
        type: "bot_start",
        bot: { id: bot.id, name: bot.name, avatar: bot.avatar },
      });
      markBotRunning(bot.id);
      let content = "";
      try {
        const gen = runBot(bot, roomId, userId, roomBots.length > 1);
        while (true) {
          const { value, done } = await gen.next();
          if (done) {
            content = value;
            break;
          }
          push(value);
        }
      } finally {
        unmarkBotRunning(bot.id);
      }
      results.push({ bot, content });
    });
    const allDone = Promise.all(workers).then(() =>
      push({ type: "__batch_done" })
    );

    while (true) {
      if (!pending.length) await waitForEvent();
      const ev = pending.shift()!;
      if (ev.type === "__batch_done") break;
      yield ev as RoomEvent;
    }
    await allDone;

    // After the batch: silence bookkeeping + @mention hand-offs.
    for (const { bot, content } of results) {
      if (SILENT_RE.test(content)) {
        console.log(
          `[orchestrate] ${bot.name} stayed silent in room ${roomId}`
        );
        yield { type: "bot_silent", botId: bot.id };
        continue;
      }
      // Bots mentioned in this reply may respond next
      for (const next of resolveResponders(content, roomBots, bot.id)) {
        if (!responded.has(next.id) && !queue.some((q) => q.id === next.id)) {
          queue.push(next);
        }
      }
    }
  }

  yield { type: "done" };
}
