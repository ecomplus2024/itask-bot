import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { resolveGeminiKey } from "@/lib/settings";
import { getRoomBots, resolveBotConfig } from "@/lib/bots";
import { getBuiltinTools } from "@/lib/builtin-tools";
import db from "@/lib/db";

export const runtime = "nodejs";

// Live voice mode is a 1-bot conversation: it returns the bot's full
// persona (identity + skills + memories) plus its tool declarations,
// converted to Gemini Live format. Unavailable when the room has no
// bot or several (group orchestration stays on the cascade path).
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const roomId = Number(req.nextUrl.searchParams.get("roomId"));
  const room = db
    .prepare("SELECT id, name FROM rooms WHERE id = ? AND user_id = ?")
    .get(roomId, user.id) as { id: number; name: string } | undefined;
  if (!room)
    return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (!resolveGeminiKey(user.id))
    return NextResponse.json({ available: false, reason: "no_gemini_key" });

  const bots = getRoomBots(roomId, user.id);
  if (bots.length !== 1)
    return NextResponse.json({ available: false, reason: "not_single_bot" });

  const bot = bots[0];
  const config = resolveBotConfig(bot);
  const { tools } = getBuiltinTools(user.id, bot.id, roomId, 0);

  const systemInstruction =
    config.systemPrompt +
    `\n\n## Voice conversation rules\n` +
    `You are speaking to the user in a real-time VOICE conversation, not text. ` +
    `ALWAYS reply in natural spoken Vietnamese (tiếng Việt) — never switch to ` +
    `another language unless the user explicitly asks. Keep it short and ` +
    `conversational — a sentence or two at a time, like a real colleague on ` +
    `a call. Never use markdown, bullet points, tables or emojis — this is ` +
    `spoken aloud. When you need data, call tools — tell the user briefly ` +
    `("để em xem ngay") while it runs.`;

  return NextResponse.json({
    available: true,
    bot: { id: bot.id, name: bot.name, avatar: bot.avatar },
    systemInstruction,
    tools: [
      {
        functionDeclarations: tools.map((t) => ({
          name: t.function.name,
          description: t.function.description,
          parametersJsonSchema: t.function.parameters,
        })),
      },
    ],
  });
}
