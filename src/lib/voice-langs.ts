// Shared voice configuration — client-safe (no db imports).
// `dg` is the Deepgram `language=` code (nova-3); `bcp` is the BCP-47
// locale used by Edge TTS voices and Gemini Live's languageCode.
export const VOICE_LANGS = [
  { dg: "vi", bcp: "vi-VN", label: "Tiếng Việt" },
  { dg: "en-US", bcp: "en-US", label: "English (US)" },
  { dg: "en-GB", bcp: "en-GB", label: "English (UK)" },
  { dg: "ja", bcp: "ja-JP", label: "日本語" },
  { dg: "ko", bcp: "ko-KR", label: "한국어" },
  { dg: "zh-CN", bcp: "zh-CN", label: "中文 (简体)" },
  { dg: "th", bcp: "th-TH", label: "ภาษาไทย" },
  { dg: "fr", bcp: "fr-FR", label: "Français" },
  { dg: "de", bcp: "de-DE", label: "Deutsch" },
  { dg: "es", bcp: "es-ES", label: "Español" },
  { dg: "multi", bcp: "", label: "Auto / multi" },
] as const;

export const DEFAULT_DG_LANG = "vi";

export function dgToBcp(dg: string | null | undefined): string {
  const hit = VOICE_LANGS.find((l) => l.dg === dg);
  return hit?.bcp || "vi-VN";
}

// Gemini Live prebuilt voices (30) — short human-readable trait.
export const LIVE_VOICES = [
  { name: "Aoede", trait: "Breezy" },
  { name: "Charon", trait: "Informative" },
  { name: "Kore", trait: "Firm" },
  { name: "Puck", trait: "Upbeat" },
  { name: "Fenrir", trait: "Excitable" },
  { name: "Leda", trait: "Youthful" },
  { name: "Orus", trait: "Firm" },
  { name: "Zephyr", trait: "Bright" },
  { name: "Callirrhoe", trait: "Easy-going" },
  { name: "Autonoe", trait: "Bright" },
  { name: "Enceladus", trait: "Breathy" },
  { name: "Iapetus", trait: "Clear" },
  { name: "Umbriel", trait: "Easy-going" },
  { name: "Algieba", trait: "Smooth" },
  { name: "Despina", trait: "Smooth" },
  { name: "Erinome", trait: "Clear" },
  { name: "Algenib", trait: "Gravelly" },
  { name: "Rasalgethi", trait: "Informative" },
  { name: "Laomedeia", trait: "Upbeat" },
  { name: "Achernar", trait: "Soft" },
  { name: "Alnilam", trait: "Firm" },
  { name: "Schedar", trait: "Even" },
  { name: "Gacrux", trait: "Mature" },
  { name: "Pulcherrima", trait: "Forward" },
  { name: "Achird", trait: "Friendly" },
  { name: "Zubenelgenubi", trait: "Casual" },
  { name: "Vindemiatrix", trait: "Gentle" },
  { name: "Sadachbia", trait: "Lively" },
  { name: "Sadaltager", trait: "Knowledgeable" },
  { name: "Sulafat", trait: "Warm" },
] as const;

export const DEFAULT_LIVE_VOICE = "Aoede";
export const DEFAULT_EDGE_VOICE = "vi-VN-HoaiMyNeural";
