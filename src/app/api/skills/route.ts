import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import db from "@/lib/db";

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Skills are shared across all bots of this user
  const skills = db
    .prepare(
      `SELECT id, name, description, content, enabled FROM skills
       WHERE user_id = ? ORDER BY id`
    )
    .all(user.id);
  return NextResponse.json({ skills });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { name, description, content } = await req.json();
  if (!name?.trim() || !content?.trim()) {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  }
  const result = db
    .prepare(
      "INSERT INTO skills (user_id, bot_id, name, description, content) VALUES (?, NULL, ?, ?, ?)"
    )
    .run(
      user.id,
      name.trim(),
      description?.trim() ?? "",
      content.trim()
    );
  const skill = db
    .prepare("SELECT id, name, description, content, enabled FROM skills WHERE id = ?")
    .get(result.lastInsertRowid);
  return NextResponse.json({ skill });
}
