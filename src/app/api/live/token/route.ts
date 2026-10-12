import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { resolveGeminiKey } from "@/lib/settings";

export const runtime = "nodejs";

// Mints a short-lived ephemeral token so the browser can connect
// straight to Gemini Live — the real API key never leaves the server,
// and our backend doesn't have to relay audio.
export async function POST(_req: NextRequest) {
  const user = await getCurrentUser();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const key = resolveGeminiKey(user.id);
  if (!key)
    return NextResponse.json({ error: "no_gemini_key" }, { status: 412 });

  const now = Date.now();
  const res = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/auth_tokens",
    {
      method: "POST",
      headers: {
        "x-goog-api-key": key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        uses: 1,
        expireTime: new Date(now + 30 * 60 * 1000).toISOString(),
        newSessionExpireTime: new Date(now + 2 * 60 * 1000).toISOString(),
      }),
    }
  );
  if (!res.ok)
    return NextResponse.json(
      { error: "token_failed", detail: await res.text().catch(() => "") },
      { status: 502 }
    );
  const data = (await res.json()) as { name?: string };
  if (!data.name)
    return NextResponse.json({ error: "token_failed" }, { status: 502 });
  return NextResponse.json({ token: data.name });
}
