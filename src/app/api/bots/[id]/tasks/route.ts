import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import db from "@/lib/db";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const user = await getCurrentUser();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const tasks = db
    .prepare(
      `SELECT t.id, t.instruction, t.interval_minutes, t.cron_expr, t.timezone, t.next_run_at,
              t.last_run_at, t.enabled, t.created_at, r.name AS room_name
       FROM bot_tasks t
       JOIN bots b ON b.id = t.bot_id
       LEFT JOIN rooms r ON r.id = t.room_id
       WHERE t.bot_id = ? AND b.user_id = ?
       ORDER BY t.enabled DESC, t.next_run_at ASC`
    )
    .all(Number(id), user.id);
  return NextResponse.json({ tasks });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const user = await getCurrentUser();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const bot = db
    .prepare("SELECT id FROM bots WHERE id = ? AND user_id = ?")
    .get(Number(id), user.id);
  if (!bot) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const taskId = req.nextUrl.searchParams.get("id");
  if (taskId) {
    db.prepare(
      "UPDATE bot_tasks SET enabled = 0 WHERE id = ? AND bot_id = ?"
    ).run(Number(taskId), Number(id));
  } else {
    db.prepare("UPDATE bot_tasks SET enabled = 0 WHERE bot_id = ?").run(
      Number(id)
    );
  }
  return NextResponse.json({ ok: true });
}
