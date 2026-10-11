import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import db from "@/lib/db";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const bot = db
    .prepare(
      `SELECT id, name, role, avatar, system_prompt, ai_base_url, ai_model,
              proactive_minutes,
              (ai_api_key IS NOT NULL) AS has_api_key
       FROM bots WHERE id = ? AND user_id = ?`
    )
    .get(Number(id), user.id);
  if (!bot) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ bot });
}

export async function PUT(req: NextRequest, ctx: Ctx) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const exists = db
    .prepare("SELECT id FROM bots WHERE id = ? AND user_id = ?")
    .get(Number(id), user.id);
  if (!exists) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const b = await req.json();
  // Empty/masked API key keeps the stored one
  let apiKey: string | null = null;
  if (typeof b.aiApiKey === "string" && b.aiApiKey.trim() && !b.aiApiKey.includes("•")) {
    apiKey = b.aiApiKey.trim();
  }
  db.prepare(
    `UPDATE bots SET
       name = COALESCE(?, name),
       role = COALESCE(?, role),
       avatar = COALESCE(?, avatar),
       system_prompt = COALESCE(?, system_prompt),
       ai_base_url = COALESCE(?, ai_base_url),
       ai_api_key = COALESCE(?, ai_api_key),
       ai_model = COALESCE(?, ai_model),
       proactive_minutes = COALESCE(?, proactive_minutes)
     WHERE id = ?`
  ).run(
    b.name, b.role, b.avatar, b.systemPrompt,
    b.aiBaseUrl, apiKey, b.aiModel,
    b.proactiveMinutes === undefined ? null : Math.max(0, Number(b.proactiveMinutes) || 0),
    Number(id)
  );
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  db.prepare("DELETE FROM bots WHERE id = ? AND user_id = ?").run(
    Number(id),
    user.id
  );
  return NextResponse.json({ ok: true });
}
