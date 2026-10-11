import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import db from "@/lib/db";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const conversations = db
    .prepare(
      `SELECT id, title, created_at, updated_at FROM conversations
       WHERE user_id = ? ORDER BY updated_at DESC`
    )
    .all(user.id);
  return NextResponse.json({ conversations });
}

export async function POST() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const result = db
    .prepare("INSERT INTO conversations (user_id) VALUES (?)")
    .run(user.id);
  const conversation = db
    .prepare("SELECT id, title, created_at, updated_at FROM conversations WHERE id = ?")
    .get(result.lastInsertRowid);
  return NextResponse.json({ conversation });
}
