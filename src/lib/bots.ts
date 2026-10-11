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

export function getBotMemories(botId: number, limit = 50): string[] {
  const rows = db
    .prepare(
      "SELECT content FROM bot_memories WHERE bot_id = ? ORDER BY id DESC LIMIT ?"
    )
    .all(botId, limit) as { content: string }[];
  return rows.map((r) => r.content);
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
    `reply is at most ~4 lines. Answer the question directly, then stop. ` +
    `NEVER dump everything you know — if more detail could help, offer to ` +
    `explain further instead. Only write long answers, lists or tables ` +
    `when the user explicitly asks for details, a guide, or a report.\n` +
    `- Mention other bots with @BotName to hand off or ask them.\n` +
    `- Keep replies clean and professional: do NOT use emoji or decorative ` +
    `icons in your answers unless the user explicitly asks for them.\n` +
    `- IMPORTANT: whenever the user shares durable facts (names, dates, deadlines, ` +
    `preferences, company info, decisions), you MUST call itask__remember BEFORE ` +
    `replying, so you remember it in future conversations.\n` +
    `- IMPORTANT: whenever the user asks you to do something LATER or ` +
    `PERIODICALLY ("X phút nữa", "sáng mai", "mỗi ngày", "báo cáo lại sau"...), ` +
    `you MUST call itask__schedule_task BEFORE replying — never just promise ` +
    `verbally, a promise without the tool does nothing. Use in_minutes ` +
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

  const memories = getBotMemories(bot.id);
  let systemPrompt = identity + getBotSkillsPrompt(bot.id, bot.user_id);
  if (memories.length) {
    systemPrompt +=
      "\n\n## Memory (things you have learned so far)\n" +
      memories.map((m) => `- ${m}`).join("\n");
  }

  return {
    baseUrl: (bot.ai_base_url || base.baseUrl).replace(/\/$/, ""),
    apiKey: bot.ai_api_key || base.apiKey,
    model: bot.ai_model || base.model,
    systemPrompt,
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
