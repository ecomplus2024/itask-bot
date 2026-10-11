import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { streamChat, chatOnce, ChatMessage } from "@/lib/ai";
import { resolveAIConfig } from "@/lib/settings";
import { getMcpTools } from "@/lib/mcp";
import { getBuiltinTools } from "@/lib/builtin-tools";
import { getSkillsPrompt } from "@/lib/skills";
import db from "@/lib/db";

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user)
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
    });

  const { conversationId, message } = await req.json();
  if (!conversationId || typeof message !== "string" || !message.trim()) {
    return new Response(JSON.stringify({ error: "Bad request" }), {
      status: 400,
    });
  }

  const conv = db
    .prepare("SELECT id, title FROM conversations WHERE id = ? AND user_id = ?")
    .get(Number(conversationId), user.id) as
    | { id: number; title: string }
    | undefined;
  if (!conv)
    return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });

  // Persist user message
  db.prepare(
    "INSERT INTO messages (conversation_id, role, content) VALUES (?, 'user', ?)"
  ).run(conv.id, message.trim());

  // Auto-title from first message
  if (conv.title === "New chat") {
    const title = message.trim().slice(0, 50);
    db.prepare("UPDATE conversations SET title = ? WHERE id = ?").run(
      title,
      conv.id
    );
  }

  // Build context (last 40 messages)
  const history = db
    .prepare(
      `SELECT role, content FROM messages
       WHERE conversation_id = ? ORDER BY id DESC LIMIT 40`
    )
    .all(conv.id)
    .reverse() as ChatMessage[];

  const config = resolveAIConfig(user.id);
  config.systemPrompt += getSkillsPrompt(user.id);

  const builtin = getBuiltinTools(user.id);
  const mcp = await getMcpTools(user.id);
  const tools = [...builtin.tools, ...mcp.tools];
  const execute = (name: string, args: Record<string, unknown>) =>
    name.startsWith("itask__") ? builtin.execute(name, args) : mcp.execute(name, args);

  if (tools.length) {
    config.systemPrompt +=
      "\n\nYou have tools available. itask__* tools let you manage your own skills and MCP server connections when the user asks.";
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let full = "";
      const emit = (text: string) => {
        full += text;
        controller.enqueue(encoder.encode(text));
      };
      try {
        if (tools.length) {
          // Tool-calling loop: non-streaming rounds until the model
          // answers without requesting tools, then emit the answer.
          const msgs: ChatMessage[] = [...history];
          let answer: string | null = null;
          let useTools = true;
          for (let round = 0; round < 5 && useTools; round++) {
            let msg: ChatMessage;
            try {
              msg = await chatOnce(msgs, config, tools);
            } catch (e) {
              // Provider may not support function calling — fall back
              // to plain streaming without tools.
              if (round === 0) {
                useTools = false;
                break;
              }
              throw e;
            }
            if (!msg.tool_calls?.length) {
              answer = msg.content;
              break;
            }
            msgs.push(msg);
            for (const tc of msg.tool_calls) {
              let args: Record<string, unknown> = {};
              try {
                args = JSON.parse(tc.function.arguments || "{}");
              } catch {
                // keep empty args
              }
              const result = await execute(tc.function.name, args);
              msgs.push({
                role: "tool",
                tool_call_id: tc.id,
                content: result.slice(0, 8000),
              });
            }
          }
          if (answer === null) {
            // Either the provider lacks tool support (useTools=false,
            // msgs === history) or the max rounds were hit.
            for await (const chunk of streamChat(msgs, config)) emit(chunk);
          } else {
            // Emit in slices so the UI still feels responsive
            for (let i = 0; i < answer.length; i += 32) {
              emit(answer.slice(i, i + 32));
            }
          }
        } else {
          for await (const chunk of streamChat(history, config)) emit(chunk);
        }
      } catch (e) {
        emit(`\n\n[Error: ${e instanceof Error ? e.message : "AI request failed"}]`);
      } finally {
        db.prepare(
          "INSERT INTO messages (conversation_id, role, content) VALUES (?, 'assistant', ?)"
        ).run(conv.id, full);
        db.prepare(
          "UPDATE conversations SET updated_at = datetime('now') WHERE id = ?"
        ).run(conv.id);
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}
