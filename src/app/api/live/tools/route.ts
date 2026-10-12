import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getRoomBots } from "@/lib/bots";
import { getBuiltinTools } from "@/lib/builtin-tools";
import db from "@/lib/db";

export const runtime = "nodejs";

// Executes a Gemini Live tool call with the real iTask tool stack —
// same executor as normal orchestration, so memory, files, ERP/MCP
// and ask_bot all work inside voice sessions too.
export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { roomId, name, args } = (await req.json().catch(() => ({}))) as {
    roomId?: number;
    name?: string;
    args?: Record<string, unknown>;
  };
  const room = db
    .prepare("SELECT id FROM rooms WHERE id = ? AND user_id = ?")
    .get(Number(roomId), user.id);
  if (!room || !name)
    return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const bots = getRoomBots(Number(roomId), user.id);
  const bot = bots[0];
  const { execute } = getBuiltinTools(user.id, bot?.id, Number(roomId), 0);
  try {
    const result = await execute(name, args ?? {});
    return NextResponse.json({ result });
  } catch (e) {
    return NextResponse.json(
      { result: `Error: ${e instanceof Error ? e.message : String(e)}` },
      { status: 200 }
    );
  }
}
