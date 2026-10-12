import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getRoomBots } from "@/lib/bots";
import { runVoiceTurn } from "@/lib/orchestrate";
import { jevEval, resolveJevKey } from "@/lib/jev";
import { pushVoiceTurn, voiceTurns } from "@/lib/voice-conv";
import db from "@/lib/db";

export const runtime = "nodejs";

// One voice-call turn: the spoken user line is answered by the bot with
// the full tool pipeline (memory, ERP/MCP, schedules…) but NOTHING is
// written to room_messages — a call leaves no chat bubbles. The spoken
// exchange lives in the ephemeral per-room voice transcript, which is
// passed back into the model context so the conversation can flow
// back and forth continuously like a phone call.
export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user)
    return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { roomId, text, botId } = (await req.json().catch(() => ({}))) as {
    roomId?: number;
    text?: string;
    botId?: number;
  };
  const room = db
    .prepare(
      "SELECT id, direct_bot_id FROM rooms WHERE id = ? AND user_id = ?"
    )
    .get(Number(roomId), user.id) as
    | { id: number; direct_bot_id: number | null }
    | undefined;
  const content = String(text ?? "").trim();
  if (!room || !content)
    return Response.json({ error: "bad_request" }, { status: 400 });

  const bots = getRoomBots(room.id, user.id);
  const bot =
    bots.find((b) => b.id === Number(botId)) ??
    bots.find((b) => b.id === room.direct_bot_id) ??
    bots[0];
  if (!bot) return Response.json({ error: "no_bot" }, { status: 400 });

  // Jev noise gate: mic captures background chatter, stray syllables
  // and mis-transcribed fragments — one fast noul verdict filters the
  // utterance BEFORE it is recorded or the bot wakes up, so noise can
  // never pollute the call transcript. No key/failure → passes through.
  if (resolveJevKey(user.id)) {
    const recent = voiceTurns(user.id, room.id)
      .slice(-6)
      .map((t) => `${t.role === "user" ? "User" : bot.name}: ${t.content}`)
      .join("\n");
    const answers = await jevEval(
      user.id,
      `Voice call in progress.` +
        (recent ? `\nRecent transcript:\n${recent}\n` : "\n") +
        `\nNew spoken utterance to evaluate: "${content.slice(0, 500)}"`,
      {
        meaningful: {
          type: "noul",
          instructions:
            "This utterance is a real message addressed to the " +
            "assistant — not background noise, stray syllables, filler " +
            "sounds, a mis-transcribed fragment, or side conversation " +
            "not meant for the assistant",
        },
      }
    );
    const v = answers?.meaningful?.noul;
    if (v != null && v <= 0.5) {
      console.log(
        `[jev] voice filtered (${v.toFixed(2)}): "${content.slice(0, 60)}"`
      );
      return new Response(
        JSON.stringify({ type: "filtered" }) +
          "\n" +
          JSON.stringify({ type: "done" }) +
          "\n",
        { headers: { "Content-Type": "application/x-ndjson" } }
      );
    }
  }

  // Record the user's spoken line BEFORE running so it is the latest
  // context entry the bot answers.
  pushVoiceTurn(user.id, room.id, {
    role: "user",
    content: `[${user.name}]: ${content}`,
  });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (e: unknown) =>
        controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
      const gen = runVoiceTurn(
        bot,
        room.id,
        user.id,
        voiceTurns(user.id, room.id)
      );
      try {
        let reply = "";
        while (true) {
          const { value, done } = await gen.next();
          if (done) {
            reply = value;
            break;
          }
          if (value.type === "delta" || value.type === "status")
            send(value);
        }
        if (reply?.trim())
          pushVoiceTurn(user.id, room.id, {
            role: "assistant",
            content: reply,
          });
      } catch {
        send({ type: "error" });
      } finally {
        // Client gone mid-turn → close the generator so its cleanup
        // (unmarkBotRunning) still runs.
        await gen.return("").catch(() => {});
      }
      send({ type: "done" });
      controller.close();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache",
    },
  });
}
