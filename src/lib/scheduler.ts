import db from "./db";
import { Bot, getBot, resolveBotConfig } from "./bots";
import { runBotInstruction } from "./orchestrate";
import { chatOnce } from "./ai";
import { nextCronRunUtc } from "./cron";

type Task = {
  id: number;
  bot_id: number;
  user_id: number;
  room_id: number | null;
  instruction: string;
  interval_minutes: number | null;
  cron_expr: string | null;
  timezone: string | null;
  next_run_at: string;
};

const TICK_MS = 30_000;

// Tasks currently executing — prevents the next tick from re-picking a
// task whose bot run is still in flight (runs can take longer than a tick).
const running = new Set<number>();
const proactiveRunning = new Set<number>();
let consolidateRunning = false;
let tickInFlight = false;

/**
 * The hidden instruction for a bot's autonomous check-in — it reviews
 * its own context and decides whether something is worth doing or
 * reporting. [[SILENT]] means "nothing needs attention".
 */
const PROACTIVE_PROMPT = `[Proactive check-in — this was NOT triggered by a user message]
You are an autonomous digital employee doing your periodic self-review, like a real employee checking their desk.
Review your memories, your role/domain, recent room history and any pending or scheduled work. If something genuinely deserves attention — an anomaly in your data, an approaching deadline, stale numbers worth re-checking, a useful insight for the user, or work you can complete right now — then act: use your tools (ERP/data queries, web search, create files, message other rooms you belong to, schedule follow-ups) and post a SHORT, natural update — only if it brings real value.
If nothing needs attention, reply [[SILENT]] — never post filler, greetings or status noise.`;

async function runDueTasks() {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    const due = db
      .prepare(
        `SELECT * FROM bot_tasks
         WHERE enabled = 1 AND datetime(next_run_at) <= datetime('now')
         ORDER BY next_run_at LIMIT 10`
      )
      .all() as Task[];

    for (const task of due) {
      if (running.has(task.id)) continue;
      running.add(task.id);
      try {
        const bot = getBot(task.bot_id, task.user_id);
        if (!bot || !task.room_id) {
          db.prepare("UPDATE bot_tasks SET enabled = 0 WHERE id = ?").run(
            task.id
          );
          continue;
        }

        // Claim the task BEFORE running: reschedule/disable now so no
        // other tick can pick it up while the bot is still answering.
        if (task.cron_expr) {
          // Calendar-based schedule: next occurrence follows the cron's
          // own timezone rules (DST-aware). Exhausted/invalid → disable.
          const next = nextCronRunUtc(
            task.cron_expr,
            task.timezone ?? "UTC"
          );
          if (next) {
            db.prepare(
              "UPDATE bot_tasks SET last_run_at = datetime('now'), next_run_at = ? WHERE id = ?"
            ).run(next, task.id);
          } else {
            db.prepare(
              "UPDATE bot_tasks SET last_run_at = datetime('now'), enabled = 0 WHERE id = ?"
            ).run(task.id);
          }
        } else if (task.interval_minutes) {
          db.prepare(
            `UPDATE bot_tasks SET
               last_run_at = datetime('now'),
               next_run_at = datetime('now', '+' || ? || ' minutes')
             WHERE id = ?`
          ).run(task.interval_minutes, task.id);
        } else {
          db.prepare(
            "UPDATE bot_tasks SET last_run_at = datetime('now'), enabled = 0 WHERE id = ?"
          ).run(task.id);
        }

        // Run silently: the instruction goes straight into the bot's
        // context — only its reply is posted to the room.
        await runBotInstruction(
          task.room_id,
          task.user_id,
          bot,
          `[Scheduled task — EXECUTE this work now: do the job described and report the result. The scheduling is already done — never call schedule tools or create new tasks from this trigger.] ${task.instruction}`
        );
      } catch (e) {
        console.error(`[scheduler] task ${task.id} failed:`, e);
      } finally {
        running.delete(task.id);
      }
    }

    // Proactive heartbeat: bots with proactive_minutes > 0 wake up on
    // their own cadence and act like employees checking their work.
    const proactive = db
      .prepare(
        `SELECT id, user_id, proactive_minutes FROM bots
         WHERE proactive_minutes > 0
           AND (last_proactive_at IS NULL
                OR datetime(last_proactive_at, '+' || proactive_minutes || ' minutes') <= datetime('now'))
         LIMIT 3`
      )
      .all() as { id: number; user_id: number; proactive_minutes: number }[];

    for (const p of proactive) {
      if (proactiveRunning.has(p.id)) continue;
      proactiveRunning.add(p.id);
      try {
        // Claim BEFORE running — heartbeat runs are slow.
        db.prepare(
          "UPDATE bots SET last_proactive_at = datetime('now') WHERE id = ?"
        ).run(p.id);

        const bot = getBot(p.id, p.user_id);
        if (!bot) continue;

        // Post to the bot's direct chat with its owner — create it if
        // the user never opened one.
        let room = db
          .prepare(
            "SELECT id FROM rooms WHERE user_id = ? AND direct_bot_id = ?"
          )
          .get(p.user_id, p.id) as { id: number } | undefined;
        if (!room) {
          const r = db
            .prepare(
              "INSERT INTO rooms (user_id, name, direct_bot_id) VALUES (?, ?, ?)"
            )
            .run(p.user_id, bot.name, p.id);
          const roomId = Number(r.lastInsertRowid);
          const ins = db.prepare(
            "INSERT OR IGNORE INTO room_members (room_id, kind, ref_id) VALUES (?, ?, ?)"
          );
          ins.run(roomId, "user", p.user_id);
          ins.run(roomId, "bot", p.id);
          room = { id: roomId };
        }

        await runBotInstruction(
          room.id,
          p.user_id,
          bot as Bot,
          PROACTIVE_PROMPT,
          true // silence allowed — no news means no post
        );
      } catch (e) {
        console.error(`[scheduler] proactive check for bot ${p.id} failed:`, e);
      } finally {
        proactiveRunning.delete(p.id);
      }
    }
    // Memory consolidation: when a bot has accumulated enough memories,
    // once a day it re-reads the whole store and has the AI merge
    // duplicates, drop entries irrelevant to its role, and prune trivia —
    // like an employee tidying their notebook in quiet moments. Logs are
    // untouched (they expire on their own).
    if (!consolidateRunning) {
      const candidate = db
        .prepare(
          `SELECT b.id, b.user_id FROM bots b
           WHERE (b.last_consolidated_at IS NULL
                  OR datetime(b.last_consolidated_at, '+1 day') <= datetime('now'))
             AND (SELECT COUNT(*) FROM bot_memories m
                  WHERE m.bot_id = b.id AND m.kind != 'log') >= 15
           ORDER BY b.last_consolidated_at LIMIT 1`
        )
        .get() as { id: number; user_id: number } | undefined;
      if (candidate) {
        consolidateRunning = true;
        // Claim BEFORE the AI call — a slow pass must not re-trigger.
        db.prepare(
          "UPDATE bots SET last_consolidated_at = datetime('now') WHERE id = ?"
        ).run(candidate.id);
        consolidateBotMemories(candidate.id, candidate.user_id)
          .catch((e) =>
            console.error(
              `[scheduler] memory consolidation bot ${candidate.id}:`,
              e
            )
          )
          .finally(() => {
            consolidateRunning = false;
          });
      }
    }
  } finally {
    tickInFlight = false;
  }
}

/**
 * One AI pass that tidies a bot's memory store. Replaces core+note rows
 * with the cleaned list inside a transaction — aborts (keeps everything)
 * when the model output is unusable, so a bad pass can never wipe memory.
 */
async function consolidateBotMemories(botId: number, userId: number) {
  const bot = getBot(botId, userId);
  if (!bot) return;
  const rows = db
    .prepare(
      `SELECT kind, topic, content FROM bot_memories
       WHERE bot_id = ? AND kind != 'log' ORDER BY id`
    )
    .all(botId) as { kind: string; topic: string | null; content: string }[];
  if (rows.length < 15) return;

  const config = resolveBotConfig(bot);
  const res = await chatOnce(
    [
      {
        role: "user",
        content:
          `You are ${bot.name}${bot.role ? ` (${bot.role})` : ""}. Below is ` +
          `your long-term memory. Tidy it: merge duplicates/overlaps, DROP ` +
          `entries not relevant to YOUR role or no longer useful, keep ` +
          `accurate facts verbatim. Return ONLY a JSON array, at most 100 ` +
          `items: [{"kind":"core"|"note","topic":"optional","content":"..."}]\n\n` +
          `MEMORY (${rows.length}):\n` +
          rows
            .map(
              (r, i) =>
                `${i + 1}. [${r.kind}${r.topic ? `:${r.topic}` : ""}] ${r.content}`
            )
            .join("\n"),
      },
    ],
    { ...config, systemPrompt: "You output only valid JSON arrays." },
    []
  );

  const text = (res.content ?? "")
    .trim()
    .replace(/^```(?:json)?\s*|\s*```$/g, "");
  let cleaned: { kind?: string; topic?: string; content?: string }[];
  try {
    cleaned = JSON.parse(text);
  } catch {
    return; // unparseable — keep the store as-is
  }
  if (!Array.isArray(cleaned) || cleaned.length === 0) return;

  const tx = db.transaction(() => {
    db.prepare("DELETE FROM bot_memories WHERE bot_id = ? AND kind != 'log'").run(
      botId
    );
    const ins = db.prepare(
      "INSERT INTO bot_memories (bot_id, kind, topic, content) VALUES (?, ?, ?, ?)"
    );
    for (const m of cleaned.slice(0, 100)) {
      if (!m.content) continue;
      ins.run(
        botId,
        m.kind === "note" ? "note" : "core",
        m.topic?.trim() || null,
        String(m.content).trim().slice(0, 2000)
      );
    }
  });
  tx();

  const kept = db
    .prepare(
      "SELECT COUNT(*) c FROM bot_memories WHERE bot_id = ? AND kind != 'log'"
    )
    .get(botId) as { c: number };
  db.prepare(
    "INSERT INTO bot_memories (bot_id, kind, content) VALUES (?, 'log', ?)"
  ).run(
    botId,
    `[${new Date().toLocaleString("sv-SE", { timeZone: "Asia/Ho_Chi_Minh" })}] Memory review: ${rows.length} → ${kept.c} mục`
  );
  console.log(
    `[scheduler] bot ${bot.name}: memory consolidated ${rows.length} → ${kept.c}`
  );
}

export function startScheduler() {
  const g = globalThis as { __itaskScheduler?: boolean };
  if (g.__itaskScheduler) return;
  g.__itaskScheduler = true;
  setInterval(() => {
    runDueTasks().catch((e) => console.error("[scheduler]", e));
  }, TICK_MS);
  console.log("[scheduler] started, tick =", TICK_MS / 1000, "s");
}
