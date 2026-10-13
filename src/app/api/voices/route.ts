import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { MsEdgeTTS, type Voice } from "msedge-tts";

export const runtime = "nodejs";

// Lists Edge Read Aloud neural voices for the Settings voice picker.
// The catalog changes rarely — cached per-process; ?lang= filters by
// locale prefix (e.g. "vi" → vi-VN voices, "en" → every English voice).
let cache: { at: number; voices: Voice[] } | null = null;

async function listVoices(): Promise<Voice[]> {
  if (cache && Date.now() - cache.at < 3600_000) return cache.voices;
  const tts = new MsEdgeTTS();
  const voices = await tts.getVoices();
  cache = { at: Date.now(), voices };
  return voices;
}

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const lang = (req.nextUrl.searchParams.get("lang") ?? "").split("-")[0];
  try {
    const voices = (await listVoices())
      .filter((v) => !lang || v.Locale.replace("_", "-").startsWith(lang))
      .map((v) => ({
        name: v.ShortName,
        label: `${v.FriendlyName.replace(/^Microsoft | Online \(Natural\) /g, "")} — ${v.Gender}`,
        locale: v.Locale,
        gender: v.Gender,
      }))
      .sort((a, b) => a.locale.localeCompare(b.locale) || a.name.localeCompare(b.name));
    return NextResponse.json({ voices });
  } catch {
    return NextResponse.json({ voices: [] });
  }
}
