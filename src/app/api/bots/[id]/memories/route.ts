import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import db from "@/lib/db";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const memories = db
    .prepare(
      `SELECT m.id, m.kind, m.topic, m.content, m.created_at FROM bot_memories m
       JOIN bots b ON b.id = m.bot_id
       WHERE m.bot_id = ? AND b.user_id = ? ORDER BY m.id DESC LIMIT 500`
    )
    .all(Number(id), user.id);
  return NextResponse.json({ memories });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const bot = db
    .prepare("SELECT id FROM bots WHERE id = ? AND user_id = ?")
    .get(Number(id), user.id);
  if (!bot) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const memId = req.nextUrl.searchParams.get("id");
  if (memId) {
    db.prepare("DELETE FROM bot_memories WHERE id = ? AND bot_id = ?").run(
      Number(memId),
      Number(id)
    );
  } else {
    db.prepare("DELETE FROM bot_memories WHERE bot_id = ?").run(Number(id));
  }
  return NextResponse.json({ ok: true });
}
