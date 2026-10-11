import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { listTools } from "@/lib/mcp";
import db from "@/lib/db";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, ctx: Ctx) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const row = db
    .prepare(
      "SELECT id, name, url, headers FROM mcp_servers WHERE id = ? AND user_id = ?"
    )
    .get(Number(id), user.id) as
    | { id: number; name: string; url: string; headers: string }
    | undefined;
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let headers: Record<string, string> = {};
  try {
    headers = JSON.parse(row.headers);
  } catch {
    // ignore
  }

  try {
    const tools = await listTools({ ...row, headers });
    return NextResponse.json({
      ok: true,
      tools: tools.map((t) => ({ name: t.name, description: t.description })),
    });
  } catch (e) {
    return NextResponse.json({
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
