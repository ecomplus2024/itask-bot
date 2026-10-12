import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";

export const runtime = "nodejs";

// Edge Read Aloud neural voices — free Vietnamese TTS (the OS and
// Electron's Chromium have no vi-VN voice, and Deepgram Aura doesn't
// support Vietnamese). HoaiMy is a natural female vi-VN voice.
const VOICE = "vi-VN-HoaiMyNeural";

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const { text } = (await req.json().catch(() => ({}))) as {
    text?: string;
  };
  const clean = (text ?? "").trim().slice(0, 3000);
  if (!clean) return new Response("empty", { status: 400 });

  try {
    const tts = new MsEdgeTTS();
    await tts.setMetadata(
      VOICE,
      OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3
    );
    const { audioStream } = tts.toStream(clean);
    const chunks: Buffer[] = [];
    for await (const c of audioStream) chunks.push(c as Buffer);
    tts.close();
    return new Response(new Uint8Array(Buffer.concat(chunks)), {
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch {
    return new Response("tts_failed", { status: 502 });
  }
}
