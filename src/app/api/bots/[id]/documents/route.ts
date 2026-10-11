import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { addDocument, deleteDocument, listDocuments } from "@/lib/knowledge";
import db from "@/lib/db";

type Ctx = { params: Promise<{ id: string }> };

async function ownedBot(ctx: Ctx, userId: number) {
  const { id } = await ctx.params;
  return db
    .prepare("SELECT id FROM bots WHERE id = ? AND user_id = ?")
    .get(Number(id), userId) as { id: number } | undefined;
}

export async function GET(_req: NextRequest, ctx: Ctx) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const bot = await ownedBot(ctx, user.id);
  if (!bot) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ documents: listDocuments(bot.id) });
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const bot = await ownedBot(ctx, user.id);
  if (!bot) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { name, content } = await req.json();
  if (!name?.trim() || !content?.trim()) {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  }
  if (content.length > 500_000) {
    return NextResponse.json({ error: "Document too large" }, { status: 400 });
  }
  const doc = addDocument(bot.id, name.trim(), content);
  return NextResponse.json({ document: doc });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const bot = await ownedBot(ctx, user.id);
  if (!bot) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const docId = Number(req.nextUrl.searchParams.get("id"));
  if (docId) deleteDocument(docId, bot.id);
  return NextResponse.json({ ok: true });
}
