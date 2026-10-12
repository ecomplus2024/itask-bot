import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getUserSettings, saveUserSettings } from "@/lib/settings";
import { envAIConfig } from "@/lib/ai";

function mask(key: string | null) {
  if (!key) return null;
  if (key.length <= 8) return "••••••••";
  return key.slice(0, 4) + "••••••••" + key.slice(-4);
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const s = getUserSettings(user.id);
  const env = envAIConfig();
  return NextResponse.json({
    settings: {
      aiBaseUrl: s.aiBaseUrl ?? "",
      aiApiKey: mask(s.aiApiKey),
      aiModel: s.aiModel ?? "",
      aiSystemPrompt: s.aiSystemPrompt ?? "",
      deepgramApiKey: mask(s.deepgramApiKey),
    },
    defaults: {
      aiBaseUrl: env.baseUrl,
      aiModel: env.model,
      aiSystemPrompt: env.systemPrompt,
      hasEnvKey: !!env.apiKey && env.apiKey !== "sk-your-key-here",
      hasDgKey: !!(s.deepgramApiKey || process.env.DEEPGRAM_API_KEY),
    },
  });
}

export async function PUT(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const current = getUserSettings(user.id);

  // Keep existing key if the submitted value is empty or still masked
  let apiKey = body.aiApiKey ?? null;
  if (!apiKey || apiKey.includes("•")) apiKey = current.aiApiKey;
  let dgKey = body.deepgramApiKey ?? null;
  if (!dgKey || dgKey.includes("•")) dgKey = current.deepgramApiKey;

  saveUserSettings(user.id, {
    aiBaseUrl: body.aiBaseUrl?.trim() || null,
    aiApiKey: apiKey?.trim() || null,
    aiModel: body.aiModel?.trim() || null,
    aiSystemPrompt: body.aiSystemPrompt?.trim() || null,
    deepgramApiKey: dgKey?.trim() || null,
  });
  return NextResponse.json({ ok: true });
}
