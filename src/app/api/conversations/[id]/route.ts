import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import db from "@/lib/db";

type Ctx = { params: Promise<{ id: string }> };

async function ownedConversation(ctx: Ctx, userId: number) {
  const { id } = await ctx.params;
  return db
    .prepare("SELECT id FROM conversations WHERE id = ? AND user_id = ?")
    .get(Number(id), userId);
}

export async function GET(_req: NextRequest, ctx: Ctx) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!(await ownedConversation(ctx, user.id)))
    return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { id } = await ctx.params;
  const messages = db
    .prepare(
      `SELECT id, role, content, created_at FROM messages
       WHERE conversation_id = ? AND role != 'system' ORDER BY id ASC`
    )
    .all(Number(id));
  return NextResponse.json({ messages });
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!(await ownedConversation(ctx, user.id)))
    return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { id } = await ctx.params;
  db.prepare("DELETE FROM conversations WHERE id = ?").run(Number(id));
  return NextResponse.json({ ok: true });
}
