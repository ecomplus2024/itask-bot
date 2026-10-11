import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import db from "@/lib/db";
import { isBotRunning } from "@/lib/status";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const bots = (
    db
      .prepare(
        `SELECT id, name, role, avatar, system_prompt, ai_base_url, ai_model,
                proactive_minutes,
                (ai_api_key IS NOT NULL) AS has_api_key, created_at
         FROM bots WHERE user_id = ? ORDER BY id`
      )
      .all(user.id) as { id: number }[]
  ).map((b) => ({ ...b, thinking: isBotRunning(b.id) }));
  return NextResponse.json({ bots });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const b = await req.json();
  if (!b.name?.trim())
    return NextResponse.json({ error: "Missing name" }, { status: 400 });
  const r = db
    .prepare(
      `INSERT INTO bots (user_id, name, role, avatar, system_prompt, ai_base_url, ai_api_key, ai_model, proactive_minutes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      user.id,
      b.name.trim(),
      b.role?.trim() ?? "",
      b.avatar?.trim() || "🤖",
      b.systemPrompt?.trim() ?? "",
      b.aiBaseUrl?.trim() || null,
      b.aiApiKey?.trim() || null,
      b.aiModel?.trim() || null,
      Math.max(0, Number(b.proactiveMinutes) || 0)
    );
  const bot = db.prepare("SELECT * FROM bots WHERE id = ?").get(r.lastInsertRowid);
  return NextResponse.json({ bot });
}
