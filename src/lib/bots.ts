import db from "./db";
import { resolveAIConfig } from "./settings";
import { AIConfig } from "./ai";

export type Bot = {
  id: number;
  user_id: number;
  name: string;
  role: string;
  avatar: string;
  system_prompt: string;
  ai_base_url: string | null;
  ai_api_key: string | null;
  ai_model: string | null;
  proactive_minutes: number;
};

export function getBot(botId: number, userId: number): Bot | undefined {
  return db.prepare("SELECT * FROM bots WHERE id = ? AND user_id = ?").get(
    botId,
    userId
  ) as Bot | undefined;
}

export function getRoomBots(roomId: number, userId: number): Bot[] {
  return db
    .prepare(
      `SELECT b.* FROM room_members rm
       JOIN bots b ON b.id = rm.ref_id
       WHERE rm.room_id = ? AND rm.kind = 'bot' AND b.user_id = ?
       ORDER BY b.id`
    )
    .all(roomId, userId) as Bot[];
}

export type MemoryKind = "core" | "note" | "log";

export type MemoryRow = {
  id: number;
  kind: MemoryKind;
  topic: string | null;
  content: string;
};

// Core memories: durable facts the bot must always carry (preferences,
// deadlines, decisions). Always injected into the prompt.
export function getBotMemories(botId: number, limit = 50): string[] {
  const rows = db
    .prepare(
      `SELECT content FROM bot_memories
       WHERE bot_id = ? AND kind = 'core' ORDER BY id DESC LIMIT ?`
    )
    .all(botId, limit) as { content: string }[];
  return rows.map((r) => r.content);
}

// Topic notes: longer notes about a specific subject, retrieved by keyword
// relevance to the current message — like OpenMausBot's topic notes.
export function getBotTopicNotes(
  botId: number,
  query: string,
  limit = 5
): string[] {
  const rows = db
    .prepare(
      `SELECT topic, content FROM bot_memories
       WHERE bot_id = ? AND kind = 'note' ORDER BY id DESC LIMIT 200`
    )
    .all(botId) as { topic: string | null; content: string }[];
  if (!rows.length || !query.trim()) return [];
  const words = new Set(
    query
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 3)
  );
  const scored = rows
    .map((r) => {
      const hay = `${r.topic ?? ""} ${r.content}`.toLowerCase();
      let s = 0;
      for (const w of words) if (hay.includes(w)) s++;
      return { r, s };
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);
  return scored
    .slice(0, limit)
    .map((x) => (x.r.topic ? `[${x.r.topic}] ` : "") + x.r.content);
}

// Daily activity log: only the last couple of days are injected — the rest
// stays in the DB as history the bot can list/forget.
export function getBotRecentLogs(botId: number, limit = 25): string[] {
  const rows = db
    .prepare(
      `SELECT content FROM bot_memories
       WHERE bot_id = ? AND kind = 'log'
         AND created_at >= datetime('now', '-2 days')
       ORDER BY id DESC LIMIT ?`
    )
    .all(botId, limit) as { content: string }[];
  return rows.map((r) => r.content).reverse();
}

// Appends one line to the bot's daily work log after each reply — the
// "what did I do today" record. Old log lines are pruned after 30 days.
export function logBotActivity(
  botId: number,
  roomName: string,
  trigger: string,
  reply: string
) {
  const ts = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Ho_Chi_Minh" });
  const line =
    `[${ts}] ${roomName}: "${trigger.replace(/\s+/g, " ").slice(0, 120)}"` +
    ` → "${reply.replace(/\s+/g, " ").slice(0, 160)}"`;
  db.prepare(
    "INSERT INTO bot_memories (bot_id, kind, content) VALUES (?, 'log', ?)"
  ).run(botId, line);
  db.prepare(
    `DELETE FROM bot_memories
     WHERE bot_id = ? AND kind = 'log' AND created_at < datetime('now', '-30 days')`
  ).run(botId);
}

export function getBotSkillsPrompt(botId: number, userId: number): string {
  // All enabled skills are shared across every bot of this user
  const rows = db
    .prepare(
      `SELECT name, content FROM skills
       WHERE user_id = ? AND enabled = 1
       ORDER BY id`
    )
    .all(userId) as { name: string; content: string }[];
  if (!rows.length) return "";
  return (
    "\n\n## Skills\n" + rows.map((s) => `### ${s.name}\n${s.content}`).join("\n\n")
  );
}

/**
 * Effective AI config for a bot: bot overrides fall back to user settings/env.
 */
export function resolveBotConfig(bot: Bot): AIConfig {
  const base = resolveAIConfig(bot.user_id);
  const persona =
    bot.system_prompt.trim() ||
    `You are ${bot.name}${bot.role ? `, ${bot.role}` : ""}, a digital employee. ` +
      `Answer helpfully and concisely in the same language the user uses.`;

  const identity =
    persona +
    `\n\nCurrent date/time: ${new Date().toLocaleString("sv-SE", { timeZone: "Asia/Ho_Chi_Minh" })} (Asia/Ho_Chi_Minh)` +
    `\n\n## Operating rules\n` +
    `- You are in a group chat. Messages are prefixed with the sender name ` +
    `like [Name]: text. You can see every message in the room.\n` +
    `- Your display name is "${bot.name}", but people may address you by ` +
    `any short form of it (e.g. the part before "-" or a first name). ` +
    `Treat those as addressing YOU.\n` +
    `- Behave like a real colleague: reply when the message is addressed to ` +
    `you, touches your role/expertise, or when you have something meaningful ` +
    `to add. If the message does not concern you or you have nothing useful ` +
    `to say, reply with exactly [[SILENT]] and nothing else. Do not reply ` +
    `just to repeat or restate what another participant already said.\n` +
    `- In a one-on-one chat (only you and the user), always reply.\n` +
    `- Chat naturally like a real human colleague. HARD RULE: a normal ` +
    `reply is at most ~4 lines. Answer the question directly, then STOP — ` +
    `the reply ends there. NEVER dump everything you know; give the ` +
    `requested info and nothing more. Only write long answers, lists or ` +
    `tables when the user explicitly asks for details, a guide, or a ` +
    `report.\n` +
    `- NEVER end a reply with a reflexive follow-up question or generic ` +
    `offer ("cần em giải thích thêm không?", "anh muốn đi sâu mục nào?", ` +
    `"let me know if you need anything else"). Real colleagues don't ` +
    `say that — they answer and wait. Only ask a question when missing ` +
    `information genuinely blocks you from doing the task.\n` +
    `- When your reply proposes actions, asks the user to CHOOSE between ` +
    `options, or needs approval/confirmation, append ONE suggestion line ` +
    `at the very end with 2-4 short tap-friendly options in the user's ` +
    `language, in this exact format:\n` +
    `[[SUGGEST: Đồng ý | Sửa lại | Xem chi tiết]]\n` +
    `The app renders these as clickable buttons — so keep each option ` +
    `short (2-5 words), make them real choices the user would plausibly ` +
    `pick, and do NOT explain them. Use suggestions only at genuine ` +
    `decision points — a plain informational answer does not get one.\n` +
    `- Mention other bots with @BotName to hand off or ask them.\n` +
    `- Keep replies clean and professional: do NOT use emoji or decorative ` +
    `icons in your answers unless the user explicitly asks for them.\n` +
    `- Use **bold** to highlight the few words/numbers/names that really ` +
    `matter in a reply (key figures, deadlines, warnings) — sparingly, ` +
    `never whole sentences.\n` +
    `- IMPORTANT: whenever the user shares durable facts (names, dates, deadlines, ` +
    `preferences, company info, decisions), you MUST call itask__remember BEFORE ` +
    `replying, so you remember it in future conversations.\n` +
    `- IMPORTANT: whenever the user asks you to do something LATER or ` +
    `PERIODICALLY ("X phút nữa", "sáng mai", "mỗi ngày", "báo cáo lại sau"...), ` +
    `you MUST call itask__schedule_task BEFORE replying — never just promise ` +
    `verbally, a promise without the tool does nothing. "Later" means a ` +
    `specific clock time or recurring cadence the user named — "ask X ` +
    `then tell me" or "find out and report" is work you do RIGHT NOW in ` +
    `this turn (contact colleagues via tools immediately). NEVER schedule ` +
    `work you can simply do now. Use in_minutes ` +
    `for "in N minutes" one-time work, run_at (ISO datetime) only for a ` +
    `specific clock time, interval_minutes for elapsed recurrences ` +
    `("every N minutes/hours"), and cron + timezone for calendar-based ` +
    `recurrences — "every weekday 9am" → cron "0 9 * * MON-FRI", "after ` +
    `8am every 3 hours" → "0 8,11,14,17,20,23 * * *" (default timezone ` +
    `Asia/Ho_Chi_Minh). ` +
    `CRITICAL: the instruction must describe the WORK to perform at run ` +
    `time — never fetch data/call tools NOW just to schedule sending the ` +
    `result later. "1 phút nữa gửi báo cáo" means: in 1 minute you wake up, ` +
    `THEN query the data and answer. Your reply to the user must be ONLY a ` +
    `short, natural confirmation — e.g. "Dạ vâng ạ" or "Vâng, 1 phút nữa ` +
    `em gửi ạ" — like a human acknowledging a request. NEVER include the ` +
    `data/result, and do NOT recite timestamps or technical details like ` +
    `"sẽ chạy lúc 00:50:28". ` +
    `To change or remove an existing schedule, call itask__list_tasks to get ` +
    `the id, then itask__update_task / itask__cancel_task.`;

  // Prompt is assembled as named sections (like OpenMausBot) so the user can
  // inspect exactly what the model sees, per section.
  const promptParts: { id: string; label: string; text: string }[] = [
    { id: "identity", label: "Identity & operating rules", text: identity },
  ];
  const skills = getBotSkillsPrompt(bot.id, bot.user_id);
  if (skills) promptParts.push({ id: "skills", label: "Skills", text: skills });

  const memories = getBotMemories(bot.id);
  if (memories.length) {
    promptParts.push({
      id: "memory",
      label: "Core memory",
      text:
        "\n\n## Memory (things you have learned so far)\n" +
        memories.map((m) => `- ${m}`).join("\n"),
    });
  }

  return {
    baseUrl: (bot.ai_base_url || base.baseUrl).replace(/\/$/, ""),
    apiKey: bot.ai_api_key || base.apiKey,
    model: bot.ai_model || base.model,
    systemPrompt: promptParts.map((p) => p.text).join(""),
    promptParts,
  };
}

/**
 * A bot's name aliases: full name plus its short form — the part before
 * a " - ", " – ", " | " separator (e.g. "Mai Anh - ADS" → "Mai Anh").
 */
export function botNameAliases(name: string): string[] {
  const short = name.split(/\s[-–—|]\s/)[0]?.trim() || name;
  return [...new Set([name, short])];
}

/**
 * Finds which bots are EXPLICITLY summoned via @mention (full name or
 * short form) — the deterministic hand-off/summon protocol. Anything
 * without "@" is left for each bot to decide itself from context:
 * every bot reads all messages and chooses to reply or stay silent.
 */
export function resolveResponders(
  content: string,
  roomBots: Bot[],
  excludeBotId?: number
): Bot[] {
  const mentioned = roomBots.filter(
    (b) =>
      b.id !== excludeBotId &&
      botNameAliases(b.name).some((alias) =>
        new RegExp(`@${escapeRegExp(alias)}\\b`, "i").test(content)
      )
  );
  if (mentioned.length) return mentioned;
  if (roomBots.length === 1 && roomBots[0].id !== excludeBotId)
    return roomBots;
  return [];
}

export function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Resolves a colleague by name: exact alias match first, then a substring
 * match — the same fuzzy naming people use in chat ("Mai Anh", "hưng").
 */
export function findBotByName(userId: number, name: string): Bot | undefined {
  const bots = db
    .prepare("SELECT * FROM bots WHERE user_id = ? ORDER BY id")
    .all(userId) as Bot[];
  const q = name.trim().replace(/^@/, "").toLowerCase();
  if (!q) return undefined;
  return (
    bots.find((b) =>
      botNameAliases(b.name).some((a) => a.toLowerCase() === q)
    ) ?? bots.find((b) => b.name.toLowerCase().includes(q))
  );
}

/**
 * Finds or creates the private bot↔bot channel for a pair of colleagues.
 * Itask__ask_bot conversations live here: a real room (kind='bot_dm') so
 * history, memory, tools and the WS stream all work unchanged — and the
 * user can watch the exchange in the UI. The pair is keyed by the two bot
 * ids, so A→B and B→A share one channel like a real DM.
 */
export function getOrCreateBotDM(
  userId: number,
  aId: number,
  aName: string,
  bId: number,
  bName: string
): number {
  const [lo, hi] = aId < bId ? [aId, bId] : [bId, aId];
  const row = db
    .prepare(
      `SELECT r.id FROM rooms r
       JOIN room_members m1 ON m1.room_id = r.id AND m1.kind = 'bot' AND m1.ref_id = ?
       JOIN room_members m2 ON m2.room_id = r.id AND m2.kind = 'bot' AND m2.ref_id = ?
       WHERE r.user_id = ? AND r.kind = 'bot_dm'`
    )
    .get(lo, hi, userId) as { id: number } | undefined;
  if (row) return row.id;

  const r = db
    .prepare(
      "INSERT INTO rooms (user_id, name, kind) VALUES (?, ?, 'bot_dm')"
    )
    .run(userId, `${aName} ↔ ${bName}`);
  const roomId = Number(r.lastInsertRowid);
  const ins = db.prepare(
    "INSERT OR IGNORE INTO room_members (room_id, kind, ref_id) VALUES (?, ?, ?)"
  );
  ins.run(roomId, "bot", aId);
  ins.run(roomId, "bot", bId);
  // The user is a member too — they can read along and jump in.
  ins.run(roomId, "user", userId);
  return roomId;
}
