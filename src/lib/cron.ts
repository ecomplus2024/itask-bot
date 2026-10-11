import { Cron } from "croner";

/**
 * Cron schedules: 5 fields (minute hour day-of-month month weekday) + an
 * explicit IANA timezone. Used as a pure date calculator — the scheduler
 * owns dispatch; jobs are created paused so no extra timers run.
 */

export function normalizeCronExpression(expr: string): string {
  return expr.trim().replace(/\s+/g, " ");
}

export function assertValidTimezone(tz: string): string {
  const clean = tz.trim();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: clean }).format(0);
  } catch {
    throw new Error(`Invalid timezone "${clean}" — use an IANA name like Asia/Ho_Chi_Minh or UTC`);
  }
  return clean;
}

/** Validates a cron schedule; throws with a human-readable reason. */
export function assertValidCron(expression: string, timezone: string): string {
  const expr = normalizeCronExpression(expression);
  if (expr.split(" ").length !== 5 || expr.includes("@")) {
    throw new Error("Cron must have 5 fields: minute hour day-of-month month weekday (e.g. '0 9 * * MON-FRI')");
  }
  assertValidTimezone(timezone);
  const cron = new Cron(expr, { timezone, paused: true });
  if (!cron.nextRun()) {
    throw new Error("This cron expression has no future runs");
  }
  return expr;
}

/** Next run instant as a SQLite UTC datetime string ('YYYY-MM-DD HH:MM:SS'). */
export function nextCronRunUtc(
  expression: string,
  timezone: string,
  after = new Date()
): string | null {
  const cron = new Cron(normalizeCronExpression(expression), {
    timezone,
    paused: true,
  });
  const next = cron.nextRun(after);
  return next ? next.toISOString().slice(0, 19).replace("T", " ") : null;
}

/** Preview helper — next N runs in the schedule's own timezone. */
export function previewCronRuns(
  expression: string,
  timezone: string,
  count = 3
): string[] {
  const cron = new Cron(normalizeCronExpression(expression), {
    timezone,
    paused: true,
  });
  const fmt = new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone,
    dateStyle: "short",
    timeStyle: "medium",
  });
  return cron.nextRuns(count).map((d) => `${fmt.format(d)} (${timezone})`);
}
