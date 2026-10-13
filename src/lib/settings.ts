import db from "./db";
import { envAIConfig, AIConfig } from "./ai";

export type UserSettings = {
  aiBaseUrl: string | null;
  aiApiKey: string | null;
  aiModel: string | null;
  aiSystemPrompt: string | null;
  deepgramApiKey: string | null;
  geminiApiKey: string | null;
  jevApiKey: string | null;
  voiceLanguage: string | null;
  voiceName: string | null;
  liveVoiceName: string | null;
};

export function getUserSettings(userId: number): UserSettings {
  const row = db
    .prepare(
      `SELECT ai_base_url, ai_api_key, ai_model, ai_system_prompt, deepgram_api_key, gemini_api_key, jev_api_key, voice_language, voice_name, live_voice_name
       FROM user_settings WHERE user_id = ?`
    )
    .get(userId) as
    | {
        ai_base_url: string | null;
        ai_api_key: string | null;
        ai_model: string | null;
        ai_system_prompt: string | null;
        deepgram_api_key: string | null;
        gemini_api_key: string | null;
        jev_api_key: string | null;
        voice_language: string | null;
        voice_name: string | null;
        live_voice_name: string | null;
      }
    | undefined;
  return {
    aiBaseUrl: row?.ai_base_url ?? null,
    aiApiKey: row?.ai_api_key ?? null,
    aiModel: row?.ai_model ?? null,
    aiSystemPrompt: row?.ai_system_prompt ?? null,
    deepgramApiKey: row?.deepgram_api_key ?? null,
    geminiApiKey: row?.gemini_api_key ?? null,
    jevApiKey: row?.jev_api_key ?? null,
    voiceLanguage: row?.voice_language ?? null,
    voiceName: row?.voice_name ?? null,
    liveVoiceName: row?.live_voice_name ?? null,
  };
}

export function saveUserSettings(userId: number, s: UserSettings) {
  db.prepare(
    `INSERT INTO user_settings (user_id, ai_base_url, ai_api_key, ai_model, ai_system_prompt, deepgram_api_key, gemini_api_key, jev_api_key, voice_language, voice_name, live_voice_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       ai_base_url = excluded.ai_base_url,
       ai_api_key = excluded.ai_api_key,
       ai_model = excluded.ai_model,
       ai_system_prompt = excluded.ai_system_prompt,
       deepgram_api_key = excluded.deepgram_api_key,
       gemini_api_key = excluded.gemini_api_key,
       jev_api_key = excluded.jev_api_key,
       voice_language = excluded.voice_language,
       voice_name = excluded.voice_name,
       live_voice_name = excluded.live_voice_name`
  ).run(userId, s.aiBaseUrl, s.aiApiKey, s.aiModel, s.aiSystemPrompt, s.deepgramApiKey, s.geminiApiKey, s.jevApiKey, s.voiceLanguage, s.voiceName, s.liveVoiceName);
}

/** Deepgram key for voice chat: user setting wins, env fallback. */
export function resolveDeepgramKey(userId: number): string | null {
  return getUserSettings(userId).deepgramApiKey ||
    process.env.DEEPGRAM_API_KEY ||
    null;
}

/** Gemini key for Live API voice mode: user setting wins, env fallback. */
export function resolveGeminiKey(userId: number): string | null {
  return getUserSettings(userId).geminiApiKey ||
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    null;
}

export function resolveAIConfig(userId: number): AIConfig {
  const env = envAIConfig();
  const s = getUserSettings(userId);
  return {
    baseUrl: (s.aiBaseUrl || env.baseUrl).replace(/\/$/, ""),
    apiKey: s.aiApiKey || env.apiKey,
    model: s.aiModel || env.model,
    systemPrompt: s.aiSystemPrompt || env.systemPrompt,
  };
}
