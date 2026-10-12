export type AIConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  /** Named prompt sections — same bytes as systemPrompt, for inspection. */
  promptParts?: { id: string; label: string; text: string }[];
};

export function envAIConfig(): AIConfig {
  return {
    baseUrl: (process.env.AI_BASE_URL ?? "https://api.openai.com/v1").replace(
      /\/$/,
      ""
    ),
    apiKey: process.env.AI_API_KEY ?? "",
    model: process.env.AI_MODEL ?? "gpt-4o-mini",
    systemPrompt:
      process.env.AI_SYSTEM_PROMPT ??
      "You are iTask Bot, a helpful AI assistant.",
  };
}

export type ChatMessage = {
  role: string;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type Tool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

/**
 * Non-streaming chat completion with optional tool definitions.
 * Returns the assistant message (may contain tool_calls).
 */
// Transient upstream statuses worth retrying (rate limit, gateway hiccups
// on free/shared AI providers).
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 529]);

export async function chatOnce(
  messages: ChatMessage[],
  config: AIConfig,
  tools?: Tool[]
): Promise<ChatMessage> {
  const body = JSON.stringify({
    model: config.model,
    stream: false,
    messages: [{ role: "system", content: config.systemPrompt }, ...messages],
    ...(tools?.length ? { tools, tool_choice: "auto" } : {}),
  });
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body,
      });
    } catch (e) {
      // Network-level failure — retry.
      lastError = e;
      if (attempt < 2) {
        await new Promise((r) =>
          setTimeout(r, 1500 * (attempt + 1) + Math.random() * 1000)
        );
        continue;
      }
      throw e;
    }
    if (res.ok) {
      const data = await res.json();
      return (
        data.choices?.[0]?.message ?? { role: "assistant", content: "" }
      );
    }
    const text = await res.text().catch(() => "");
    if (RETRYABLE_STATUS.has(res.status) && attempt < 2) {
      lastError = new Error(`AI request failed (${res.status})`);
      await new Promise((r) =>
        setTimeout(r, 2000 * (attempt + 1) + Math.random() * 1000)
      );
      continue;
    }
    // Keep raw HTML error pages out of the message — they are noise.
    const snippet = text.includes("<") ? "" : `: ${text.slice(0, 300)}`;
    throw new Error(`AI request failed (${res.status})${snippet}`);
  }
  throw lastError;
}

/**
 * Streams chat completion deltas from an OpenAI-compatible endpoint.
 * Yields text chunks as they arrive.
 */
export async function* streamChat(
  messages: ChatMessage[],
  config: AIConfig = envAIConfig()
): AsyncGenerator<string> {
  const res = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      stream: true,
      messages: [{ role: "system", content: config.systemPrompt }, ...messages],
    }),
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`AI request failed (${res.status}): ${text.slice(0, 300)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") return;
      try {
        const json = JSON.parse(payload);
        const delta = json.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta.length > 0) yield delta;
      } catch {
        // skip malformed SSE chunk
      }
    }
  }
}
