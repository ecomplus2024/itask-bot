import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import db from "@/lib/db";

type Ctx = { params: Promise<{ id: string }> };

async function owned(ctx: Ctx, userId: number) {
  const { id } = await ctx.params;
  return db
    .prepare("SELECT id FROM skills WHERE id = ? AND user_id = ?")
    .get(Number(id), userId);
}

export async function PUT(req: NextRequest, ctx: Ctx) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!(await owned(ctx, user.id)))
    return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { id } = await ctx.params;
  const { name, description, content, enabled } = await req.json();
  db.prepare(
    `UPDATE skills SET
       name = COALESCE(?, name),
       description = COALESCE(?, description),
       content = COALESCE(?, content),
       enabled = COALESCE(?, enabled)
     WHERE id = ?`
  ).run(name, description, content, enabled == null ? null : enabled ? 1 : 0, Number(id));
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!(await owned(ctx, user.id)))
    return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { id } = await ctx.params;
  db.prepare("DELETE FROM skills WHERE id = ?").run(Number(id));
  return NextResponse.json({ ok: true });
}
