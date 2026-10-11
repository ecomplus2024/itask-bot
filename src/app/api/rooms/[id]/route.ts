import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import db from "@/lib/db";

type Ctx = { params: Promise<{ id: string }> };

async function owned(ctx: Ctx, userId: number) {
  const { id } = await ctx.params;
  return db
    .prepare("SELECT id FROM rooms WHERE id = ? AND user_id = ?")
    .get(Number(id), userId);
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!(await owned(ctx, user.id)))
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { id } = await ctx.params;
  db.prepare("DELETE FROM rooms WHERE id = ?").run(Number(id));
  return NextResponse.json({ ok: true });
}

export async function PUT(req: NextRequest, ctx: Ctx) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!(await owned(ctx, user.id)))
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { id } = await ctx.params;
  const { name, botIds } = await req.json();
  if (name?.trim())
    db.prepare("UPDATE rooms SET name = ? WHERE id = ?").run(
      name.trim(),
      Number(id)
    );
  if (Array.isArray(botIds)) {
    db.prepare(
      "DELETE FROM room_members WHERE room_id = ? AND kind = 'bot'"
    ).run(Number(id));
    const ownedBot = db.prepare(
      "SELECT id FROM bots WHERE id = ? AND user_id = ?"
    );
    const ins = db.prepare(
      "INSERT OR IGNORE INTO room_members (room_id, kind, ref_id) VALUES (?, 'bot', ?)"
    );
    for (const bid of botIds) {
      if (ownedBot.get(Number(bid), user.id)) ins.run(Number(id), Number(bid));
    }
  }
  return NextResponse.json({ ok: true });
}
