import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { loadRoomMessages, orchestrate } from "@/lib/orchestrate";
import { notifyRoomChanged } from "@/lib/bus";
import db from "@/lib/db";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const room = db
    .prepare("SELECT id FROM rooms WHERE id = ? AND user_id = ?")
    .get(Number(id), user.id);
  if (!room) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ messages: loadRoomMessages(Number(id), 200) });
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const user = await getCurrentUser();
  if (!user)
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
    });
  const { id } = await ctx.params;
  const roomId = Number(id);
  const room = db
    .prepare("SELECT id FROM rooms WHERE id = ? AND user_id = ?")
    .get(roomId, user.id);
  if (!room)
    return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });

  const { content } = await req.json();
  if (typeof content !== "string" || !content.trim())
    return new Response(JSON.stringify({ error: "Empty message" }), {
      status: 400,
    });

  const saved = db
    .prepare(
      `INSERT INTO room_messages (room_id, kind, sender_id, sender_name, content)
       VALUES (?, 'user', ?, ?, ?)`
    )
    .run(roomId, user.id, user.name, content.trim());
  db.prepare("UPDATE rooms SET updated_at = datetime('now') WHERE id = ?").run(
    roomId
  );
  notifyRoomChanged(roomId);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (e: unknown) =>
        controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
      send({
        type: "message",
        message: {
          id: Number(saved.lastInsertRowid),
          kind: "user",
          sender_id: user.id,
          sender_name: user.name,
          content: content.trim(),
          created_at: new Date().toISOString(),
        },
      });
      try {
        for await (const e of orchestrate(roomId, user.id, content.trim())) {
          send(e);
        }
      } catch (err) {
        send({
          type: "delta",
          botId: 0,
          text: `[Error: ${err instanceof Error ? err.message : String(err)}]`,
        });
        send({ type: "done" });
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}
