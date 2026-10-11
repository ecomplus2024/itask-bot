import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import db from "@/lib/db";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const rooms = db
    .prepare(
      `SELECT r.id, r.name, r.direct_bot_id, r.created_at, r.updated_at FROM rooms r
       WHERE r.user_id = ? ORDER BY r.updated_at DESC`
    )
    .all(user.id);
  const memberStmt = db.prepare(
    `SELECT b.id, b.name, b.avatar FROM room_members rm
     JOIN bots b ON b.id = rm.ref_id
     WHERE rm.room_id = ? AND rm.kind = 'bot'`
  );
  const result = (rooms as { id: number }[]).map((r) => ({
    ...r,
    bots: memberStmt.all(r.id),
  }));
  return NextResponse.json({ rooms: result });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { name, botIds, directBotId } = await req.json();
  if (!name?.trim())
    return NextResponse.json({ error: "Missing name" }, { status: 400 });

  const r = db
    .prepare("INSERT INTO rooms (user_id, name, direct_bot_id) VALUES (?, ?, ?)")
    .run(user.id, name.trim(), directBotId ? Number(directBotId) : null);
  const roomId = Number(r.lastInsertRowid);

  const ins = db.prepare(
    "INSERT OR IGNORE INTO room_members (room_id, kind, ref_id) VALUES (?, ?, ?)"
  );
  ins.run(roomId, "user", user.id);
  const ownedBot = db.prepare("SELECT id FROM bots WHERE id = ? AND user_id = ?");
  for (const bid of botIds ?? []) {
    if (ownedBot.get(Number(bid), user.id)) ins.run(roomId, "bot", Number(bid));
  }

  return NextResponse.json({ room: { id: roomId, name: name.trim() } });
}
