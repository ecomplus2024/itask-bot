import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import db from "@/lib/db";

// Marks the room as read up to its latest message — the user's read
// cursor moves forward so only messages saved AFTER this call count
// as unread.
export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const user = await getCurrentUser();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const roomId = Number(id);
  const owned = db
    .prepare("SELECT id FROM rooms WHERE id = ? AND user_id = ?")
    .get(roomId, user.id);
  if (!owned) return NextResponse.json({ error: "Not found" }, { status: 404 });

  db.prepare(
    `INSERT INTO room_reads (user_id, room_id, last_read_id)
     VALUES (?, ?, (SELECT COALESCE(MAX(id), 0) FROM room_messages WHERE room_id = ?))
     ON CONFLICT(user_id, room_id)
     DO UPDATE SET last_read_id = excluded.last_read_id`
  ).run(user.id, roomId, roomId);
  return NextResponse.json({ ok: true });
}
