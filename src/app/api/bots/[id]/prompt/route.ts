import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import db from "@/lib/db";
import { getBot } from "@/lib/bots";
import { prepareBotTurn } from "@/lib/orchestrate";
import { estimateTokens } from "@/lib/context";

type Ctx = { params: Promise<{ id: string }> };

/**
 * "What the model sees" — builds the exact system prompt the bot would
 * receive for its next turn in a room, split into named sections with byte
 * and token counts. Read-only: no compaction, no tool runs.
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  const user = await getCurrentUser();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const bot = getBot(Number(id), user.id);
  if (!bot) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Room to preview against: explicit ?room_id, else the bot's direct room,
  // else its most recently active room.
  let roomId = Number(req.nextUrl.searchParams.get("room_id")) || 0;
  if (!roomId) {
    const row = db
      .prepare(
        `SELECT r.id FROM rooms r
         JOIN room_members rm ON rm.room_id = r.id AND rm.kind = 'bot' AND rm.ref_id = ?
         WHERE r.user_id = ? ORDER BY r.updated_at DESC LIMIT 1`
      )
      .get(bot.id, user.id) as { id: number } | undefined;
    roomId = row?.id ?? 0;
  }
  if (!roomId)
    return NextResponse.json({ error: "Bot is not in any room" }, { status: 404 });

  const { config } = await prepareBotTurn(bot, roomId, user.id, undefined, 0, {
    preview: true,
  });
  const sections = (config.promptParts ?? []).map((p) => ({
    id: p.id,
    label: p.label,
    bytes: Buffer.byteLength(p.text, "utf8"),
    tokens: estimateTokens(p.text),
    text: p.text.trim(),
  }));
  return NextResponse.json({
    bot: { id: bot.id, name: bot.name },
    room_id: roomId,
    model: config.model,
    sections,
    total_bytes: sections.reduce((s, x) => s + x.bytes, 0),
    est_tokens: sections.reduce((s, x) => s + x.tokens, 0),
  });
}
