import db from "./db";
import {
  Bot,
  getRoomBots,
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

function saveBotMessage(roomId: number, bot: Bot, content: string) {
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
  config.systemPrompt += `\n\nYou are in room "${roomInfo?.name ?? roomId}". Members present: ${roster}.`;

  // Colleague directory: who to ask when work needs another bot's skills
  // or data. itask__ask_bot runs the colleague and returns their answer
  // synchronously — the tool for "I need X from them to finish MY task".
  const colleagues = db
    .prepare(
      "SELECT name, role FROM bots WHERE user_id = ? AND id != ? ORDER BY id"
    )
    .all(userId, bot.id) as { name: string; role: string | null }[];
  if (colleagues.length) {
    config.systemPrompt +=
      `\n\nYour colleagues: ${colleagues
        .map((c) => `${c.name}${c.role ? ` — ${c.role}` : ""}`)
        .join("; ")}. ` +
      `When you need a colleague's information or output to complete your ` +
      `own task, call itask__ask_bot (it returns their answer to you ` +
      `directly). To hand work off publicly, @mention them in your reply.`;
  }

  // Bot↔bot DM: the reply IS the work product handed to the colleague —
  // the usual ~4-line chat limit would truncate it, so completeness wins.
  if (isBotDM) {
    config.systemPrompt +=
      `\n\nThis is your private channel with a colleague. They contacted ` +
      `you for help — give the FULL answer or work result they need ` +
      `(data, files, analysis), not a 4-line summary. Be complete but ` +
      `focused; skip small talk.`;
  }

  // List the OTHER rooms this bot belongs to, with ids and members, so
  // it can resolve references like "nhóm công việc" and delegate work
  // there via itask__send_room_message.
  const otherRooms = db
    .prepare(
      `SELECT r.id, r.name FROM rooms r
       JOIN room_members rm ON rm.room_id = r.id
       WHERE rm.kind = 'bot' AND rm.ref_id = ? AND r.user_id = ? AND r.id != ?`
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
    config.systemPrompt +=
      `\n\nOther rooms you belong to: ${desc}. ` +
      `To delegate work to bots in one of those rooms, call ` +
      `itask__send_room_message with that room's id and @mention the bots ` +
      `you want to act.`;
  }

  // Compact when the projected history exceeds the token budget,
  // then reload the context (summary + verbatim tail).
  if (
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
      config.systemPrompt +=
        "\n\n## Knowledge base (relevant excerpts)\n" +
        hits.map((h) => `---\n${h}`).join("\n");
    }
  }

  const builtin = getBuiltinTools(userId, bot.id, roomId, collabDepth);
  const mcp = await getMcpTools(userId);
  const tools: OpenAITool[] = [...builtin.tools, ...mcp.tools];
  const execute = (name: string, args: Record<string, unknown>) =>
    name.startsWith("itask__")
      ? builtin.execute(name, args)
      : mcp.execute(name, args);

  config.systemPrompt +=
    "\n\nYou have tools available: itask__* for managing your memory, skills, " +
    "MCP servers, your own profile (itask__update_profile), your schedule, " +
    "messaging other rooms, and creating files for the user " +
    "(itask__create_file — csv/xlsx/html/md/txt; use it whenever the user " +
    "wants a report, export or document), plus tools from your connected " +
    "MCP servers.";

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
          config
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
              `facts and any direct question, drop headings and lecture ` +
              `format. Output the rewritten message only.\n\n${answer}`,
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
 * AI-based action verification. Instead of pattern-matching keywords, a
 * small model call inspects the user's trigger + the bot's reply + the
 * tools actually called, and reports which required actions are missing.
 */
async function verifyActions(
  triggerText: string,
  reply: string,
  calledTools: Set<string>,
  config: Parameters<typeof chatOnce>[1]
): Promise<string[]> {
  const schedTools = [
    "itask__schedule_task",
    "itask__update_task",
    "itask__cancel_task",
  ];
  const scheduleCalled = schedTools.some((t) => calledTools.has(t));
  const rememberCalled = calledTools.has("itask__remember");

  // Nothing to verify: scheduling happened AND the reply doesn't claim
  // memory work — but remembering can still be missing, so only skip the
  // AI call when both concerns are already satisfied or irrelevant.
  if (scheduleCalled && rememberCalled) return [];

  try {
    const res = await chatOnce(
      [
        {
          role: "user",
          content:
            `You verify whether an assistant actually performed required ` +
            `actions or only claimed them in words.\n\n` +
            `USER REQUEST: ${triggerText || "(scheduled run / unknown)"}\n\n` +
            `ASSISTANT REPLY: ${reply}\n\n` +
            `TOOLS ACTUALLY CALLED: ${[...calledTools].join(", ") || "none"}\n\n` +
            `Rules:\n` +
            `- If the user asked for work to happen LATER, at a specific ` +
            `future time, or PERIODICALLY (e.g. "in N minutes", "tomorrow", ` +
            `"every morning", "remind me", "báo cáo lại sau"), a scheduling ` +
            `tool MUST have been called. The job belongs to the future run, ` +
            `not to the reply. Note: a reply that merely confirms a schedule ` +
            `it just created is fine.\n` +
            `- If the assistant claims it noted/saved/remembered/will ` +
            `remember something, itask__remember MUST have been called.\n` +
            `- If the user only shared information and the assistant merely ` +
            `acknowledged receipt (no claim to store), no tool is required.\n` +
            `Reply with a JSON object only, e.g. ` +
            `{"missing": []} or {"missing": ["schedule", "remember"]}.`,
        },
      ],
      { ...config, systemPrompt: "You are a strict JSON verifier." },
      []
    );
    const text = res.content ?? "";
    const json = JSON.parse(
      text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1) || "{}"
    ) as { missing?: string[] };
    const missing: string[] = [];
    if (
      json.missing?.includes("schedule") &&
      !scheduleCalled
    ) {
      missing.push(
        "a scheduling tool (itask__schedule_task / itask__update_task / itask__cancel_task — call itask__list_tasks first if you need the task id) — the user asked for work to happen LATER or PERIODICALLY, but nothing was scheduled. Schedule the WHOLE job for that future time and reply with ONLY a brief confirmation — do NOT include the result/data itself."
      );
    }
    if (json.missing?.includes("remember") && !rememberCalled) {
      missing.push(
        "itask__remember — you said you noted/remembered something but nothing was stored"
      );
    }
    return missing;
  } catch {
    return [];
  }
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
  const queue: Bot[] = [
    ...mentioned,
    ...roomBots.filter((b) => !mentioned.some((m) => m.id === b.id)),
  ];
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
