import { NextResponse } from "next/server";
import { getSessionToken, destroySession, clearSessionCookie } from "@/lib/auth";

export async function POST() {
  const token = await getSessionToken();
  if (token) destroySession(token);
  await clearSessionCookie();
  return NextResponse.json({ ok: true });
}
