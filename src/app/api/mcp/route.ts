import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import db from "@/lib/db";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // MCP servers are shared across all bots of this user
  const servers = db
    .prepare(
      `SELECT id, name, url, headers, enabled FROM mcp_servers
       WHERE user_id = ? ORDER BY id`
    )
    .all(user.id);
  return NextResponse.json({ servers });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { name, url, headers } = await req.json();
  if (!name?.trim() || !url?.trim()) {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  }
  let headersJson = "{}";
  if (headers && typeof headers === "object") headersJson = JSON.stringify(headers);
  else if (typeof headers === "string" && headers.trim()) {
    try {
      JSON.parse(headers);
      headersJson = headers.trim();
    } catch {
      return NextResponse.json({ error: "Invalid headers JSON" }, { status: 400 });
    }
  }
  const result = db
    .prepare("INSERT INTO mcp_servers (user_id, bot_id, name, url, headers) VALUES (?, NULL, ?, ?, ?)")
    .run(user.id, name.trim(), url.trim(), headersJson);
  const server = db
    .prepare("SELECT id, name, url, headers, enabled FROM mcp_servers WHERE id = ?")
    .get(result.lastInsertRowid);
  return NextResponse.json({ server });
}
