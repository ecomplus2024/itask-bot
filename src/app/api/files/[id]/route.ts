import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import db from "@/lib/db";

type Ctx = { params: Promise<{ id: string }> };

type FileRow = {
  id: number;
  name: string;
  mime: string;
  size: number;
  content: Buffer;
  bot_name: string | null;
  room_name: string | null;
  created_at: string;
};

function getFile(id: number, userId: number): FileRow | undefined {
  return db
    .prepare(
      `SELECT f.id, f.name, f.mime, f.size, f.content, f.created_at,
              b.name AS bot_name, r.name AS room_name
       FROM files f
       LEFT JOIN bots b ON b.id = f.bot_id
       LEFT JOIN rooms r ON r.id = f.room_id
       WHERE f.id = ? AND f.user_id = ?`
    )
    .get(id, userId) as FileRow | undefined;
}

function parseCsv(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => l.split(",").map((c) => c.trim().replace(/^"|"$/g, "")));
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const user = await getCurrentUser();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const file = getFile(Number(id), user.id);
  if (!file)
    return NextResponse.json({ error: "Not found" }, { status: 404 });

  // ?format=json → parsed tabular data for the in-app viewer
  if (req.nextUrl.searchParams.get("format") === "json") {
    let rows: unknown[][] = [];
    try {
      if (file.mime.includes("spreadsheetml")) {
        const XLSX = await import("xlsx");
        const wb = XLSX.read(file.content, { type: "buffer" });
        rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], {
          header: 1,
          defval: "",
        }) as unknown[][];
      } else if (file.mime === "text/csv") {
        rows = parseCsv(file.content.toString("utf8"));
      }
    } catch {
      rows = [];
    }
    return NextResponse.json({
      id: file.id,
      name: file.name,
      mime: file.mime,
      size: file.size,
      created_at: file.created_at,
      bot_name: file.bot_name,
      room_name: file.room_name,
      rows: rows.slice(0, 500),
      truncated: rows.length > 500,
    });
  }

  // Raw content — inline for viewing, attachment when ?download=1
  const download = req.nextUrl.searchParams.has("download");
  const disposition = download
    ? `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`
    : "inline";
  // Text types need an explicit charset — bot-generated HTML rarely
  // declares <meta charset>, so Vietnamese would render as mojibake.
  const contentType =
    file.mime.startsWith("text/") || file.mime === "application/json"
      ? `${file.mime}; charset=utf-8`
      : file.mime;
  return new NextResponse(new Uint8Array(file.content), {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": disposition,
      "Cache-Control": "no-store",
    },
  });
}
