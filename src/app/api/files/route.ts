import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import db from "@/lib/db";

export async function GET() {
  const user = await getCurrentUser();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const files = db
    .prepare(
      `SELECT f.id, f.name, f.mime, f.size, f.created_at,
              b.name AS bot_name, r.name AS room_name
       FROM files f
       LEFT JOIN bots b ON b.id = f.bot_id
       LEFT JOIN rooms r ON r.id = f.room_id
       WHERE f.user_id = ?
       ORDER BY f.id DESC
       LIMIT 200`
    )
    .all(user.id);
  return NextResponse.json({ files });
}
