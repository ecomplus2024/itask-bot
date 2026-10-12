import db from "./db";

/**
 * Jev (TypeSafe "System One") — a fast structured-decision model.
 * We send a state + typed questions and get back values our code can
 * branch on directly (noul 0–1, choice, score) — no text generation,
 * no parsing. Used for cheap pre-decisions: "does this need real work?"
 * and "which bots does this message concern?".
 *
 * Enabled per-user via the Jev API key in Settings (or JEV_API_KEY /
 * TYPESAFE_API_KEY env). No key → callers fall back to LLM behavior.
 */

export type JevQuestion =
  | { type: "noul"; instructions: string }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

export type JevAnswer = {
  type: string;
  noul?: number;
  choice?: string;
  score?: number;
  confidence?: number;
};

export function resolveJevKey(userId: number): string | null {
  const row = db
    .prepare("SELECT jev_api_key FROM user_settings WHERE user_id = ?")
    .get(userId) as { jev_api_key: string | null } | undefined;
  return (
    row?.jev_api_key ||
    process.env.JEV_API_KEY ||
    process.env.TYPESAFE_API_KEY ||
    null
  );
}

/**
 * Evaluates questions against a state in one request. Returns the answers
 * map, or null when Jev is not configured or the call failed — callers
 * must treat null as "fall back to the LLM path".
 */
export async function jevEval(
  userId: number,
  state: string,
  questions: Record<string, JevQuestion>
): Promise<Record<string, JevAnswer> | null> {
  const key = resolveJevKey(userId);
  if (!key) return null;
  try {
    const res = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        state: state.slice(0, 12000),
        model: "jev-latest",
        questions,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.warn("[jev] request failed:", res.status);
      return null;
    }
    const data = await res.json();
    return (data.answers ?? null) as Record<string, JevAnswer> | null;
  } catch (e) {
    console.warn("[jev] eval error:", e);
    return null;
  }
}
