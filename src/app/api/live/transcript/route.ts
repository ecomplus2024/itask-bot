import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getRoomBots } from "@/lib/bots";
import { notifyRoomChanged } from "@/lib/bus";
import db from "@/lib/db";

export const runtime = "nodejs";

// Persists Live-session turns as normal room messages so the voice
// conversation lives in the same history/memory context as typed chat.
export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { roomId, kind, content } = (await req.json().catch(() => ({}))) as {
    roomId?: number;
    kind?: string;
    content?: string;
  };
  const room = db
    .prepare("SELECT id FROM rooms WHERE id = ? AND user_id = ?")
    .get(Number(roomId), user.id);
  const text = (content ?? "").trim();
  if (!room || !text || (kind !== "user" && kind !== "bot"))
    return NextResponse.json({ error: "bad_request" }, { status: 400 });

  let senderId = user.id;
  let senderName = user.name;
  if (kind === "bot") {
    const bot = getRoomBots(Number(roomId), user.id)[0];
    if (!bot)
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    senderId = bot.id;
    senderName = bot.name;
  }

  const saved = db
    .prepare(
      `INSERT INTO room_messages (room_id, kind, sender_id, sender_name, content)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(Number(roomId), kind, senderId, senderName, text);
  db.prepare("UPDATE rooms SET updated_at = datetime('now') WHERE id = ?").run(
    Number(roomId)
  );
  notifyRoomChanged(Number(roomId));
  return NextResponse.json({ id: Number(saved.lastInsertRowid) });
}
