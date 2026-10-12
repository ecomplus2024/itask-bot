import db from "./db";
import { jevEval, resolveJevKey } from "./jev";
import { listTools, McpServer } from "./mcp";
import type { OpenAITool } from "./mcp";
import { assertValidCron, nextCronRunUtc } from "./cron";
import { notifyRoomChanged } from "./bus";

const FILE_MIME: Record<string, string> = {
  csv: "text/csv",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  html: "text/html",
  md: "text/markdown",
  txt: "text/plain",
  json: "application/json",
  // Images: svg is text the bot can author itself (charts, diagrams);
  // raster formats come in via a `url` download or a base64 data URL.
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

/**
 * Built-in tools that let the AI manage its own skills and MCP servers.
 * Names are prefixed itask__ to avoid collisions with MCP tools.
 */
// Limits for synchronous colleague chains (ask_bot): A→B→C is fine, deeper
// nesting balloons latency and cost. A global in-flight cap also protects
// the shared AI gateway when several rooms delegate at once.
const MAX_COLLAB_DEPTH = 2;
const MAX_ACTIVE_ASKS = 4;
let activeAsks = 0;

export function getBuiltinTools(
  userId: number,
  botId?: number,
  roomId?: number,
  collabDepth = 0
): {
  tools: OpenAITool[];
  execute: (name: string, args: Record<string, unknown>) => Promise<string>;
  /** Files created by itask__create_file during this run — auto-linked in the reply. */
  createdFiles: { name: string; url: string }[];
} {
  const createdFiles: { name: string; url: string }[] = [];
  const tools: OpenAITool[] = [
    ...(botId
      ? [
          {
            type: "function" as const,
            function: {
              name: "itask__remember",
              description:
                "Save a distilled LESSON to your long-term memory — like training yourself: the CORRECT way to do something after a mistake or user correction, rules and preferences the user stated, durable facts YOUR work needs. NOT for recording what happened in chats — conversation history is already stored; recall older discussions with itask__search_history. SCOPE RULE: only what concerns YOUR OWN role and work — a colleague's job is theirs to remember. Kinds: 'core' = lessons/rules/facts always loaded into your context — default, keep it short; 'note' = a longer reference note about a specific topic (procedures, project details), loaded only when the conversation touches that topic.",
              parameters: {
                type: "object",
                properties: {
                  content: {
                    type: "string",
                    description: "The fact or note to remember",
                  },
                  kind: {
                    type: "string",
                    enum: ["core", "note"],
                    description:
                      "'core' (default) for short durable facts, 'note' for longer topic-specific notes",
                  },
                  topic: {
                    type: "string",
                    description:
                      "For kind='note': the subject this note is about (e.g. 'quy trình hoàn đơn')",
                  },
                },
                required: ["content"],
              },
            },
          },
          {
            type: "function" as const,
            function: {
              name: "itask__list_memories",
              description: "List everything you have remembered so far",
              parameters: { type: "object", properties: {} },
            },
          },
          {
            type: "function" as const,
            function: {
              name: "itask__search_history",
              description:
                "Search your OWN past conversations — every room you are a member of. Use when the user asks about something discussed earlier (yesterday, last week, a specific date) that is not among the recent messages or in your memory.",
              parameters: {
                type: "object",
                properties: {
                  days: {
                    type: "number",
                    description:
                      "How many days back to look (default 7, max 90)",
                  },
                  keyword: {
                    type: "string",
                    description: "Optional text to filter messages by",
                  },
                  room_id: {
                    type: "number",
                    description: "Optional: search only this room",
                  },
                },
                required: [],
              },
            },
          },
          {
            type: "function" as const,
            function: {
              name: "itask__update_profile",
              description:
                "Update your own profile: rename yourself, change avatar emoji, role or personality/system prompt — when the user asks or it improves your identity.",
              parameters: {
                type: "object",
                properties: {
                  name: { type: "string", description: "Your new display name" },
                  avatar: {
                    type: "string",
                    description:
                      "Avatar: an emoji (e.g. 🤖), an icon name prefixed with 'icon:', or an IMAGE — either a '/files/ID' path or an http(s) image URL. To give yourself a real avatar image: create an .svg with itask__create_file (or fetch a web image via its url param), then set avatar to the returned /files/ID path. Available icons: " +
                      "bot, sparkles, brain, rocket, zap, cpu, message-square, " +
                      "line-chart, shopping-cart, package, megaphone, target, " +
                      "briefcase, code, globe, wrench, lightbulb, star, search, " +
                      "calendar, mail, database, shield, users, headphones, pen-tool",
                  },
                  role: { type: "string", description: "Your job role" },
                  system_prompt: {
                    type: "string",
                    description: "New personality/instruction text",
                  },
                },
              },
            },
          },
          {
            type: "function" as const,
            function: {
              name: "itask__forget",
              description: "Delete a memory by its id (from itask__list_memories)",
              parameters: {
                type: "object",
                properties: { id: { type: "number" } },
                required: ["id"],
              },
            },
          },
          {
            type: "function" as const,
            function: {
              name: "itask__schedule_task",
              description:
                "Schedule WORK to be executed later or periodically — the instruction is performed AT RUN TIME, not now. Do NOT do the work now and schedule only 'sending the result'; put the entire job into the instruction (e.g. 'query top-selling products via erp_call_api and report the result'), so when the time comes you will actually fetch fresh data and answer.",
              parameters: {
                type: "object",
                properties: {
                  instruction: {
                    type: "string",
                    description: "What you should do when the task runs",
                  },
                  in_minutes: {
                    type: "number",
                    description:
                      "PREFERRED for one-time 'in N minutes' requests (e.g. '1 phút nữa' → 1) — the server computes the exact time, avoiding clock math errors.",
                  },
                  run_at: {
                    type: "string",
                    description:
                      "ISO datetime for one-time run at a specific clock time, e.g. 2026-10-15T08:00:00. Only use when the user gives an exact time/date — do NOT compute 'in N minutes' yourself, use in_minutes.",
                  },
                  interval_minutes: {
                    type: "number",
                    description:
                      "Repeat every N ELAPSED minutes — only for 'every N minutes/hours' style recurrences. For clock-time recurrences (9am daily, weekdays, 1st of month) use cron instead.",
                  },
                  cron: {
                    type: "string",
                    description:
                      "5-field cron 'minute hour day month weekday' for calendar-based recurring schedules: '0 9 * * MON-FRI' = 9am weekdays, '0 9 1 * *' = 9am on the 1st of each month, '30 17 * * FRI' = 5:30pm Fridays.",
                  },
                  timezone: {
                    type: "string",
                    description:
                      "IANA timezone for the cron schedule, e.g. Asia/Ho_Chi_Minh. Defaults to the server's timezone.",
                  },
                },
                required: ["instruction"],
              },
            },
          },
          {
            type: "function" as const,
            function: {
              name: "itask__list_tasks",
              description: "List your scheduled tasks",
              parameters: { type: "object", properties: {} },
            },
          },
          {
            type: "function" as const,
            function: {
              name: "itask__update_task",
              description:
                "Update one of your scheduled tasks — change instruction, run time, or repeat interval. Call itask__list_tasks first to get task ids.",
              parameters: {
                type: "object",
                properties: {
                  id: { type: "number" },
                  instruction: {
                    type: "string",
                    description: "New instruction text",
                  },
                  in_minutes: {
                    type: "number",
                    description: "Reschedule to run once in N minutes from now",
                  },
                  run_at: {
                    type: "string",
                    description: "New ISO datetime for next run",
                  },
                  interval_minutes: {
                    type: "number",
                    description:
                      "New repeat interval in minutes; 0 converts to one-time",
                  },
                  cron: {
                    type: "string",
                    description:
                      "New 5-field cron expression; overrides interval/one-time",
                  },
                  timezone: {
                    type: "string",
                    description: "IANA timezone for the cron schedule",
                  },
                },
                required: ["id"],
              },
            },
          },
          {
            type: "function" as const,
            function: {
              name: "itask__cancel_task",
              description: "Cancel a scheduled task by id",
              parameters: {
                type: "object",
                properties: { id: { type: "number" } },
                required: ["id"],
              },
            },
          },
          {
            type: "function" as const,
            function: {
              name: "itask__send_room_message",
              description:
                "Post a message into ANOTHER room/group you are a member of — e.g. to delegate work to the bots there. The message appears under your name; @mention the bots you want to act and they will respond in that room.",
              parameters: {
                type: "object",
                properties: {
                  room_id: {
                    type: "number",
                    description:
                      "Target room id — see 'Rooms you belong to' in your context",
                  },
                  content: {
                    type: "string",
                    description:
                      "Message to post, e.g. '@Hưng sản phẩm @Mai Anh - ADS tổng hợp doanh thu hôm qua giúp em'",
                  },
                },
                required: ["room_id", "content"],
              },
            },
          },
          ...(collabDepth < MAX_COLLAB_DEPTH
            ? [
                {
                  type: "function" as const,
                  function: {
                    name: "itask__ask_bot",
                    description:
                      "Ask a colleague bot a direct question and get their answer back immediately — use it when you need their expertise or data to complete your own work (e.g. ask the sales bot for numbers before writing a report). The exchange happens in your private bot↔bot channel and is visible to the user. For public hand-offs in the current room just @mention instead; for delegating work to another group without needing the answer now, use itask__send_room_message.",
                    parameters: {
                      type: "object",
                      properties: {
                        bot: {
                          type: "string",
                          description:
                            "Colleague name — full name or short form, see 'Your colleagues' in your context",
                        },
                        question: {
                          type: "string",
                          description:
                            "What to ask or delegate — include all context they need (they do not see this room's chat)",
                        },
                      },
                      required: ["bot", "question"],
                    },
                  },
                },
              ]
            : []),
          {
            type: "function" as const,
            function: {
              name: "itask__create_file",
              description:
                "Create a downloadable file for the user — reports, exports, documents, images. Supported: .csv, .xlsx (JSON array of row objects), .html, .md, .txt, .json, .svg (author the markup yourself — great for charts/diagrams), .png/.jpg/.webp/.gif (pass `url` to fetch an existing image, or `content` as a base64 data URL). The file link is attached to your reply automatically — for images also embed it inline with markdown ![tên](/files/ID) so it shows as a picture.",
              parameters: {
                type: "object",
                properties: {
                  filename: {
                    type: "string",
                    description: "e.g. bao-cao-doanh-thu.xlsx",
                  },
                  content: {
                    type: "string",
                    description:
                      "File contents: CSV text, HTML document, markdown/plain text, SVG markup, a JSON array of row objects for .xlsx, or a base64 data URL for raster images",
                  },
                  url: {
                    type: "string",
                    description:
                      "Optional — fetch the file content from this URL instead of `content` (use for web images/binary files)",
                  },
                },
                required: ["filename"],
              },
            },
          },
        ]
      : []),
    {
      type: "function",
      function: {
        name: "itask__web_search",
        description:
          "Search the web for current information — news, prices, regulations, facts you don't know.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "itask__fetch_url",
        description:
          "Fetch a web page or URL and read its text content (APIs, docs, articles).",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "URL to fetch" },
          },
          required: ["url"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "itask__create_skill",
        description:
          "Save a VERIFIED PROCEDURE as a reusable skill — the exact steps that produced a correct result (which tools, queries, formats, order). Create this AFTER the user confirms a deliverable was right (or accepts it without corrections), so the same task is done right immediately next time. When the user later corrects the output, fix the steps with itask__update_skill. NOT for facts or memories — use itask__remember for those.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Skill name" },
            description: { type: "string", description: "Short description" },
            content: {
              type: "string",
              description: "Instruction content injected into system prompt",
            },
          },
          required: ["name", "content"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "itask__use_skill",
        description:
          "Load the full procedure of a skill by id (from the skills index in your system prompt or itask__list_skills). Call this BEFORE doing a task that matches a listed skill — then follow its steps.",
        parameters: {
          type: "object",
          properties: { id: { type: "number" } },
          required: ["id"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "itask__list_skills",
        description: "List all skills with their enabled status",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "itask__update_skill",
        description: "Update a skill's name, description, content or enabled status",
        parameters: {
          type: "object",
          properties: {
            id: { type: "number" },
            name: { type: "string" },
            description: { type: "string" },
            content: { type: "string" },
            enabled: { type: "boolean" },
          },
          required: ["id"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "itask__delete_skill",
        description: "Delete a skill by id",
        parameters: {
          type: "object",
          properties: { id: { type: "number" } },
          required: ["id"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "itask__add_mcp_server",
        description:
          "Connect a new MCP server (Streamable HTTP transport) so its tools become available in chat",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string" },
            url: { type: "string", description: "MCP server endpoint URL" },
            headers: {
              type: "object",
              description: "Optional HTTP headers e.g. {\"Authorization\": \"Bearer ...\"}",
            },
          },
          required: ["name", "url"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "itask__list_mcp_servers",
        description: "List configured MCP servers with enabled status",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "itask__test_mcp_server",
        description: "Test an MCP server connection and list its available tools",
        parameters: {
          type: "object",
          properties: { id: { type: "number" } },
          required: ["id"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "itask__update_mcp_server",
        description: "Enable/disable an MCP server or update its name, url, headers",
        parameters: {
          type: "object",
          properties: {
            id: { type: "number" },
            name: { type: "string" },
            url: { type: "string" },
            headers: { type: "object" },
            enabled: { type: "boolean" },
          },
          required: ["id"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "itask__delete_mcp_server",
        description: "Remove an MCP server connection",
        parameters: {
          type: "object",
          properties: { id: { type: "number" } },
          required: ["id"],
        },
      },
    },
  ];

  async function execute(
    name: string,
    args: Record<string, unknown>
  ): Promise<string> {
    switch (name) {
      case "itask__remember": {
        if (!botId) return "Memory is only available to bots";
        const kind = args.kind === "note" ? "note" : "core";
        const topic = args.topic ? String(args.topic).trim() || null : null;
        const content = String(args.content ?? "").trim();
        if (!content) return JSON.stringify({ ok: false, error: "empty" });
        // Dedupe: bots tend to re-save the same fact every time it comes
        // up — keep the existing row instead of stacking duplicates.
        const norm = content.toLowerCase().replace(/\s+/g, " ");
        const dup = (
          db
            .prepare(
              "SELECT id, content FROM bot_memories WHERE bot_id = ? AND kind = ?"
            )
            .all(botId, kind) as { id: number; content: string }[]
        ).find(
          (m) => m.content.toLowerCase().replace(/\s+/g, " ") === norm
        );
        if (dup) return JSON.stringify({ ok: true, id: dup.id, deduped: true });
        // Jev vetting: prompt rules alone still let stray/ephemeral stuff
        // leak into memory — when Jev is configured, one call with two
        // fast nouls checks the entry is (a) in THIS bot's role scope and
        // (b) a durable lesson worth keeping, not just a record of what
        // happened. Failures save as normal — Jev can never block memory.
        if (resolveJevKey(userId)) {
          const b = db
            .prepare("SELECT name, role FROM bots WHERE id = ?")
            .get(botId) as { name: string; role: string | null } | undefined;
          const answers = await jevEval(
            userId,
            `${b?.name ?? "This bot"}${b?.role ? ` (${b.role})` : ""} is ` +
              `about to store this in its long-term learned memory:\n` +
              `"${content.slice(0, 1000)}"`,
            {
              in_scope: {
                type: "noul",
                instructions:
                  `This concerns ${b?.name ?? "the bot"}'s own role and ` +
                  `work${b?.role ? ` (${b.role})` : ""} — it is not a ` +
                  `colleague's job or unrelated information overheard in ` +
                  `a group`,
              },
              worth_keeping: {
                type: "noul",
                instructions:
                  "This is a durable lesson worth keeping long-term — a " +
                  "corrected method, a stated rule or preference, " +
                  "knowledge that improves future work — rather than " +
                  "ephemeral chatter or a record of what happened",
              },
            }
          );
          const inScope = answers?.in_scope?.noul;
          const worth = answers?.worth_keeping?.noul;
          const reject =
            inScope != null && inScope <= 0.5
              ? "out_of_scope"
              : worth != null && worth <= 0.5
                ? "not_a_lesson"
                : null;
          if (reject) {
            console.log(
              `[jev] ${b?.name}: rejected memory (${reject}): ` +
                `"${content.slice(0, 60)}"`
            );
            return JSON.stringify({
              ok: false,
              skipped: reject,
              message:
                reject === "out_of_scope"
                  ? "Not stored: this does not concern YOUR role — leave " +
                    "it for the colleague it belongs to."
                  : "Not stored: this is ephemeral conversation detail, " +
                    "not a lasting lesson. Chat history already keeps it " +
                    "— recall it with itask__search_history when needed.",
            });
          }
        }
        const r = db
          .prepare(
            "INSERT INTO bot_memories (bot_id, kind, topic, content) VALUES (?, ?, ?, ?)"
          )
          .run(botId, kind, topic, content);
        return JSON.stringify({ ok: true, id: Number(r.lastInsertRowid) });
      }
      case "itask__list_memories": {
        if (!botId) return "Memory is only available to bots";
        return JSON.stringify(
          db
            .prepare(
              `SELECT id, kind, topic, content, created_at FROM bot_memories
               WHERE bot_id = ? AND kind != 'log' ORDER BY id DESC LIMIT 100`
            )
            .all(botId)
        );
      }
      case "itask__search_history": {
        if (!botId) return "History search is only available to bots";
        const days = Math.min(Math.max(Number(args.days) || 7, 1), 90);
        const kw = args.keyword ? `%${String(args.keyword).trim()}%` : null;
        const rid = args.room_id != null ? Number(args.room_id) : null;
        const rows = db
          .prepare(
            `SELECT m.created_at, m.sender_name, m.content, m.room_id,
                    r.name AS room
             FROM room_messages m
             JOIN rooms r ON r.id = m.room_id AND r.user_id = ?
             JOIN room_members rm ON rm.room_id = m.room_id
               AND rm.kind = 'bot' AND rm.ref_id = ?
             WHERE m.created_at >= datetime('now', ?)
               AND (? IS NULL OR m.content LIKE ?)
               AND (? IS NULL OR m.room_id = ?)
             ORDER BY m.id DESC LIMIT 30`
          )
          .all(userId, botId, `-${days} days`, kw, kw, rid, rid) as {
          created_at: string;
          sender_name: string;
          content: string;
          room_id: number;
          room: string | null;
        }[];
        if (!rows.length) return JSON.stringify({ found: 0 });
        return rows
          .map(
            (r) =>
              `[${r.created_at}] ${r.room ?? `room ${r.room_id}`} — ` +
              `${r.sender_name}: ${r.content.replace(/\s+/g, " ").slice(0, 300)}`
          )
          .join("\n");
      }
      case "itask__forget": {
        if (!botId) return "Memory is only available to bots";
        db.prepare("DELETE FROM bot_memories WHERE id = ? AND bot_id = ?").run(
          Number(args.id),
          botId
        );
        return JSON.stringify({ ok: true });
      }
      case "itask__update_profile": {
        if (!botId) return "Profile updates are only available to bots";
        db.prepare(
          `UPDATE bots SET
             name = COALESCE(?, name),
             avatar = COALESCE(?, avatar),
             role = COALESCE(?, role),
             system_prompt = COALESCE(?, system_prompt)
           WHERE id = ? AND user_id = ?`
        ).run(
          args.name ? String(args.name).trim() : null,
          args.avatar ? String(args.avatar).trim() : null,
          args.role != null ? String(args.role).trim() : null,
          args.system_prompt ? String(args.system_prompt).trim() : null,
          botId,
          userId
        );
        return JSON.stringify({ ok: true });
      }
      case "itask__web_search": {
        const q = String(args.query ?? "");
        try {
        const res = await fetch(
          `https://www.bing.com/search?q=${encodeURIComponent(q)}&count=10`,
          {
            headers: {
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
              "Accept-Language": "vi-VN,vi;q=0.9,en;q=0.8",
            },
          }
        );
        const html = await res.text();
        const strip = (s: string) =>
          s
            .replace(/<[^>]+>/g, "")
            .replace(/&\w+;/g, " ")
            .replace(/\s+/g, " ")
            .trim();
        const decodeBingUrl = (href: string) => {
          const u = href.match(/[?&]u=a1([^&]+)/);
          if (!u) return href.replace(/&amp;/g, "&");
          try {
            return Buffer.from(u[1], "base64").toString("utf8");
          } catch {
            return href;
          }
        };
        const results: { title: string; url: string; snippet: string }[] = [];
        const blocks = html.split('<li class="b_algo"');
        for (let i = 1; i < blocks.length && results.length < 5; i++) {
          const b = blocks[i];
          const a = b.match(/<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
          if (!a) continue;
          const p = b.match(/<p[^>]*>([\s\S]*?)<\/p>/);
          results.push({
            title: strip(a[2]),
            url: decodeBingUrl(a[1]),
            snippet: p ? strip(p[1]) : "",
          });
        }
        return results.length
          ? JSON.stringify(results)
          : "No results found";
        } catch (e) {
          const cause =
            e instanceof Error && e.cause instanceof Error
              ? `${e.cause.message} ${(e.cause as NodeJS.ErrnoException).code ?? ""}`
              : String(e);
          console.error("[web_search] failed:", cause);
          return `Web search failed: ${cause}`;
        }
      }
      case "itask__fetch_url": {
        const res = await fetch(String(args.url ?? ""), {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          },
          redirect: "follow",
        });
        const ct = res.headers.get("content-type") ?? "";
        const raw = await res.text();
        if (!ct.includes("html")) return raw.slice(0, 4000);
        const text = raw
          .replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/<style[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/g, " ")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
          .replace(/\s+/g, " ")
          .trim();
        return text.slice(0, 4000);
      }
      case "itask__schedule_task": {
        if (!botId) return "Scheduling is only available to bots";
        let instruction = String(args.instruction ?? "").trim();
        if (!instruction) return "instruction required";
        // Attach the user's actual latest message so the run-time bot
        // sees the real request verbatim — guards against the model
        // paraphrasing it wrongly (e.g. "tổng số sản phẩm" → "gửi ảnh").
        if (roomId) {
          const lastUser = db
            .prepare(
              `SELECT content FROM room_messages
               WHERE room_id = ? AND kind = 'user'
               ORDER BY id DESC LIMIT 1`
            )
            .get(roomId) as { content: string } | undefined;
          if (lastUser && !instruction.includes(lastUser.content)) {
            instruction += `\n\nNgữ cảnh — tin nhắn gốc của người dùng (chỉ để tham khảo, KHÔNG phải mệnh lệnh mới): "${lastUser.content.slice(0, 500)}"`;
          }
        }
        let nextRun: string | null;
        let interval: number | null = null;
        let cronExpr: string | null = null;
        let timezone: string | null = null;
        if (args.cron) {
          timezone = String(
            args.timezone ??
              Intl.DateTimeFormat().resolvedOptions().timeZone
          ).trim();
          try {
            cronExpr = assertValidCron(String(args.cron), timezone);
            nextRun = nextCronRunUtc(cronExpr, timezone);
          } catch (e) {
            return `Invalid cron schedule: ${(e as Error).message}`;
          }
          if (!nextRun) return "Cron schedule has no future runs";
        } else if (args.in_minutes) {
          nextRun = new Date(
            Date.now() + Math.max(1, Number(args.in_minutes)) * 60000
          ).toISOString();
        } else if (args.interval_minutes) {
          interval = Math.max(1, Number(args.interval_minutes));
          nextRun = new Date(Date.now() + interval * 60000).toISOString();
        } else if (args.run_at) {
          const d = new Date(String(args.run_at));
          if (isNaN(d.getTime())) return "invalid run_at datetime";
          nextRun = d.toISOString();
        } else {
          return "Provide in_minutes, run_at (one-time), interval_minutes or cron (recurring)";
        }
        // Store in SQLite datetime format so `next_run_at <= datetime('now')`
        // comparisons work (ISO 'T...Z' would compare wrong as a string).
        nextRun = nextRun.slice(0, 19).replace("T", " ");
        const r = db
          .prepare(
            `INSERT INTO bot_tasks (bot_id, user_id, room_id, instruction, interval_minutes, cron_expr, timezone, next_run_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            botId,
            userId,
            roomId ?? null,
            instruction,
            interval,
            cronExpr,
            timezone,
            nextRun
          );
        return JSON.stringify({
          ok: true,
          id: Number(r.lastInsertRowid),
          cron: cronExpr,
          timezone,
          next_run_at: nextRun,
        });
      }
      case "itask__list_tasks": {
        if (!botId) return "Scheduling is only available to bots";
        return JSON.stringify(
          db
            .prepare(
              `SELECT id, instruction, interval_minutes, cron_expr, timezone, next_run_at, last_run_at, enabled
               FROM bot_tasks WHERE bot_id = ? ORDER BY next_run_at`
            )
            .all(botId)
        );
      }
      case "itask__update_task": {
        if (!botId) return "Scheduling is only available to bots";
        const id = Number(args.id);
        const existing = db
          .prepare("SELECT * FROM bot_tasks WHERE id = ? AND bot_id = ?")
          .get(id, botId) as
          | {
              instruction: string;
              interval_minutes: number | null;
              next_run_at: string;
              enabled: number;
            }
          | undefined;
        if (!existing) return `No task with id ${id} found`;
        if (!existing.enabled) return `Task ${id} is already cancelled`;

        const instruction =
          args.instruction !== undefined
            ? String(args.instruction).trim()
            : existing.instruction;
        if (!instruction) return "instruction cannot be empty";

        const existingFull = existing as typeof existing & {
          cron_expr: string | null;
          timezone: string | null;
        };
        let interval =
          args.interval_minutes !== undefined
            ? Number(args.interval_minutes)
            : existing.interval_minutes;
        if (interval !== null && interval <= 0) interval = null;
        if (interval !== null) interval = Math.max(1, interval as number);

        let cronExpr = existingFull.cron_expr;
        let timezone = existingFull.timezone;
        let nextRun = existing.next_run_at;
        if (args.cron !== undefined) {
          timezone = String(
            args.timezone ??
              existingFull.timezone ??
              Intl.DateTimeFormat().resolvedOptions().timeZone
          ).trim();
          try {
            cronExpr = assertValidCron(String(args.cron), timezone);
            nextRun = nextCronRunUtc(cronExpr, timezone)!;
          } catch (e) {
            return `Invalid cron schedule: ${(e as Error).message}`;
          }
          interval = null;
        } else if (args.in_minutes !== undefined) {
          nextRun = new Date(
            Date.now() + Math.max(1, Number(args.in_minutes)) * 60000
          )
            .toISOString()
            .slice(0, 19)
            .replace("T", " ");
          cronExpr = null;
        } else if (args.run_at !== undefined) {
          const d = new Date(String(args.run_at));
          if (isNaN(d.getTime())) return "invalid run_at datetime";
          nextRun = d.toISOString().slice(0, 19).replace("T", " ");
          cronExpr = null;
        } else if (args.interval_minutes !== undefined) {
          // Interval changed without explicit run_at → reschedule from now.
          nextRun = interval
            ? new Date(Date.now() + interval * 60000)
                .toISOString()
                .slice(0, 19)
                .replace("T", " ")
            : existing.next_run_at;
          cronExpr = null;
        }

        db.prepare(
          `UPDATE bot_tasks SET instruction = ?, interval_minutes = ?, cron_expr = ?, timezone = ?, next_run_at = ?
           WHERE id = ? AND bot_id = ?`
        ).run(instruction, interval, cronExpr, timezone, nextRun, id, botId);
        return JSON.stringify({
          ok: true,
          id,
          cron: cronExpr,
          timezone,
          next_run_at: nextRun,
        });
      }
      case "itask__cancel_task": {
        if (!botId) return "Scheduling is only available to bots";
        const r = db
          .prepare(
            "UPDATE bot_tasks SET enabled = 0 WHERE id = ? AND bot_id = ?"
          )
          .run(Number(args.id), botId);
        return r.changes
          ? JSON.stringify({ ok: true })
          : `No task with id ${args.id} found`;
      }
      case "itask__ask_bot": {
        if (!botId) return "Colleague messaging is only available to bots";
        const targetName = String(args.bot ?? "").trim();
        const question = String(args.question ?? "").trim();
        if (!targetName || !question) return "bot and question are required";

        const { findBotByName, getOrCreateBotDM } = await import("./bots");
        const target = findBotByName(userId, targetName);
        if (!target) return `No colleague named "${targetName}"`;
        if (target.id === botId) return "You cannot ask yourself";
        if (activeAsks >= MAX_ACTIVE_ASKS)
          return "Too many colleague requests in flight — try again in a moment";

        const me = db
          .prepare("SELECT name FROM bots WHERE id = ?")
          .get(botId) as { name: string } | undefined;
        const dmId = getOrCreateBotDM(
          userId,
          botId,
          me?.name ?? "Bot",
          target.id,
          target.name
        );
        db.prepare(
          `INSERT INTO room_messages (room_id, kind, sender_id, sender_name, content)
           VALUES (?, 'bot', ?, ?, ?)`
        ).run(dmId, botId, me?.name ?? "Bot", question);
        db.prepare(
          "UPDATE rooms SET updated_at = datetime('now') WHERE id = ?"
        ).run(dmId);
        notifyRoomChanged(dmId);

        // Run the colleague's turn and wait for the answer — it is the
        // whole point of asking. Cap the wait: on timeout the turn keeps
        // running and the reply lands in the DM room for later reading.
        activeAsks++;
        try {
          const { runBotInstruction } = await import("./orchestrate");
          const reply = await Promise.race([
            runBotInstruction(
              dmId,
              userId,
              target,
              undefined,
              false,
              collabDepth + 1
            ),
            new Promise<string>((resolve) =>
              setTimeout(() => resolve(""), 120_000)
            ),
          ]);
          return reply && reply !== "…"
            ? `${target.name} replies: ${reply}`
            : `${target.name} is still working on it — their reply will appear in your private channel. Continue with what you have or check back later.`;
        } finally {
          activeAsks--;
        }
      }
      case "itask__send_room_message": {
        if (!botId) return "Room messaging is only available to bots";
        const targetRoom = Number(args.room_id);
        const content = String(args.content ?? "").trim();
        if (!content) return "content required";
        const room = db
          .prepare("SELECT id, user_id, kind FROM rooms WHERE id = ?")
          .get(targetRoom) as
          | { id: number; user_id: number; kind?: string }
          | undefined;
        if (!room || room.user_id !== userId)
          return `No room with id ${targetRoom}`;
        if (room.kind === "bot_dm")
          return "That's your private colleague channel — use itask__ask_bot so their answer comes back to you.";
        const member = db
          .prepare(
            "SELECT 1 FROM room_members WHERE room_id = ? AND kind = 'bot' AND ref_id = ?"
          )
          .get(targetRoom, botId);
        if (!member) return `You are not a member of room ${targetRoom}`;
        const me = db
          .prepare("SELECT name FROM bots WHERE id = ?")
          .get(botId) as { name: string } | undefined;
        db.prepare(
          `INSERT INTO room_messages (room_id, kind, sender_id, sender_name, content)
           VALUES (?, 'bot', ?, ?, ?)`
        ).run(targetRoom, botId, me?.name ?? "Bot", content);
        db.prepare(
          "UPDATE rooms SET updated_at = datetime('now') WHERE id = ?"
        ).run(targetRoom);
        notifyRoomChanged(targetRoom);
        // Fire the target room's orchestration in the background so the
        // bots there actually see the message and respond. Dynamic import
        // avoids a circular dependency with ./orchestrate.
        void (async () => {
          try {
            const { orchestrate } = await import("./orchestrate");
            for await (const _ of orchestrate(targetRoom, userId, content)) {
              // drain events — replies are persisted by runBot
            }
          } catch (e) {
            console.error("[send_room_message] orchestration failed:", e);
          }
        })();
        return `Message posted to room ${targetRoom}. The bots there will respond in that room.`;
      }
      case "itask__create_file": {
        if (!botId) return "File creation is only available to bots";
        const rawName = String(args.filename ?? "file.txt")
          .replace(/[/\\?%*:|"<>]/g, "-")
          .trim();
        const ext = rawName.includes(".")
          ? rawName.split(".").pop()!.toLowerCase()
          : "";
        const mime = FILE_MIME[ext];
        if (!mime)
          return `Unsupported extension ".${ext}" — use: ${Object.keys(FILE_MIME).join(", ")}`;

        let data: Buffer;
        if (args.url) {
          // Fetch an existing file (e.g. a web image) and store it.
          try {
            const res = await fetch(String(args.url), {
              signal: AbortSignal.timeout(15_000),
            });
            if (!res.ok) return `Could not download: HTTP ${res.status}`;
            data = Buffer.from(await res.arrayBuffer());
          } catch (e) {
            return `Could not download: ${e instanceof Error ? e.message : e}`;
          }
          if (data.length > 15 * 1024 * 1024) return "File too large (>15MB)";
        } else {
        let text = String(args.content ?? "");
        // Base64 data URL (e.g. a generated raster image)
        const dataUrl = /^data:([\w/+.-]+);base64,([\s\S]+)$/.exec(text.trim());
        if (dataUrl) {
          data = Buffer.from(dataUrl[2], "base64");
        } else {
        // Models often wrap file contents in markdown fences (```html … ```)
        // or emit HTML-escaped markup — clean both so the file renders.
        text = text
          .replace(/^\s*```[a-zA-Z]*\s*\n/, "")
          .replace(/\n\s*```\s*$/, "");
        if (!text.includes("<") && /&(lt|gt|amp|quot);/.test(text)) {
          text = text
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&amp;/g, "&");
        }
        if (ext === "xlsx") {
          try {
            const XLSX = await import("xlsx");
            let rows: unknown;
            try {
              rows = JSON.parse(text);
            } catch {
              // Fallback: treat content as CSV text → rows of cells
              rows = text
                .split(/\r?\n/)
                .filter((l) => l.trim())
                .map((l) => l.split(",").map((c) => c.trim()));
            }
            const ws = Array.isArray(rows) && rows.length && !Array.isArray(rows[0])
              ? XLSX.utils.json_to_sheet(rows as Record<string, unknown>[])
              : XLSX.utils.aoa_to_sheet(rows as unknown[][]);
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
            data = XLSX.write(wb, {
              type: "buffer",
              bookType: "xlsx",
            }) as Buffer;
          } catch (e) {
            return `Could not build xlsx: ${e instanceof Error ? e.message : e}. Pass a JSON array of row objects.`;
          }
        } else {
          data = Buffer.from(text, "utf8");
        }
        }
        }

        const name = ext ? rawName : `${rawName}.txt`;
        // Same-name file already created this run → overwrite instead of duplicating
        const dup = createdFiles.find((f) => f.name === name);
        if (dup) {
          const dupId = Number(dup.url.split("/").pop());
          db.prepare("UPDATE files SET content = ?, size = ? WHERE id = ?").run(
            data,
            data.length,
            dupId
          );
          return JSON.stringify({ ok: true, file_id: dupId, url: dup.url });
        }
        const r = db
          .prepare(
            `INSERT INTO files (user_id, bot_id, room_id, name, mime, size, content)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(userId, botId, roomId ?? null, name, mime, data.length, data);
        const fileId = Number(r.lastInsertRowid);
        const url = `/files/${fileId}`;
        createdFiles.push({ name, url });
        return JSON.stringify({ ok: true, file_id: fileId, url });
      }
      case "itask__create_skill": {
        const r = db
          .prepare(
            "INSERT INTO skills (user_id, bot_id, name, description, content) VALUES (?, ?, ?, ?, ?)"
          )
          .run(
            userId,
            null,
            String(args.name ?? "").trim(),
            String(args.description ?? "").trim(),
            String(args.content ?? "").trim()
          );
        return JSON.stringify({ ok: true, id: Number(r.lastInsertRowid) });
      }
      case "itask__use_skill": {
        const s = db
          .prepare(
            "SELECT name, description, content FROM skills WHERE id = ? AND user_id = ? AND enabled = 1"
          )
          .get(Number(args.id), userId) as
          | { name: string; description: string | null; content: string }
          | undefined;
        if (!s) return JSON.stringify({ ok: false, error: "skill not found" });
        return `## Skill: ${s.name}${s.description ? ` — ${s.description}` : ""}\n\n${s.content}`;
      }
      case "itask__list_skills": {
        return JSON.stringify(
          db
            .prepare(
              "SELECT id, name, description, enabled FROM skills WHERE user_id = ? ORDER BY id"
            )
            .all(userId)
        );
      }
      case "itask__update_skill": {
        db.prepare(
          `UPDATE skills SET
             name = COALESCE(?, name),
             description = COALESCE(?, description),
             content = COALESCE(?, content),
             enabled = COALESCE(?, enabled)
           WHERE id = ? AND user_id = ?`
        ).run(
          args.name ?? null,
          args.description ?? null,
          args.content ?? null,
          args.enabled == null ? null : args.enabled ? 1 : 0,
          Number(args.id),
          userId
        );
        return JSON.stringify({ ok: true });
      }
      case "itask__delete_skill": {
        db.prepare("DELETE FROM skills WHERE id = ? AND user_id = ?").run(
          Number(args.id),
          userId
        );
        return JSON.stringify({ ok: true });
      }
      case "itask__add_mcp_server": {
        const r = db
          .prepare(
            "INSERT INTO mcp_servers (user_id, bot_id, name, url, headers) VALUES (?, ?, ?, ?, ?)"
          )
          .run(
            userId,
            null,
            String(args.name ?? "").trim(),
            String(args.url ?? "").trim(),
            JSON.stringify(args.headers ?? {})
          );
        return JSON.stringify({ ok: true, id: Number(r.lastInsertRowid) });
      }
      case "itask__list_mcp_servers": {
        return JSON.stringify(
          db
            .prepare(
              "SELECT id, name, url, enabled FROM mcp_servers WHERE user_id = ? ORDER BY id"
            )
            .all(userId)
        );
      }
      case "itask__test_mcp_server": {
        const row = db
          .prepare(
            "SELECT id, name, url, headers FROM mcp_servers WHERE id = ? AND user_id = ?"
          )
          .get(Number(args.id), userId) as
          | { id: number; name: string; url: string; headers: string }
          | undefined;
        if (!row) return "MCP server not found";
        let headers: Record<string, string> = {};
        try {
          headers = JSON.parse(row.headers);
        } catch {
          // ignore
        }
        const server: McpServer = { ...row, headers };
        const tools = await listTools(server);
        return JSON.stringify({
          ok: true,
          toolCount: tools.length,
          tools: tools.map((t) => t.name),
        });
      }
      case "itask__update_mcp_server": {
        db.prepare(
          `UPDATE mcp_servers SET
             name = COALESCE(?, name),
             url = COALESCE(?, url),
             headers = COALESCE(?, headers),
             enabled = COALESCE(?, enabled)
           WHERE id = ? AND user_id = ?`
        ).run(
          args.name ?? null,
          args.url ?? null,
          args.headers ? JSON.stringify(args.headers) : null,
          args.enabled == null ? null : args.enabled ? 1 : 0,
          Number(args.id),
          userId
        );
        return JSON.stringify({ ok: true });
      }
      case "itask__delete_mcp_server": {
        db.prepare(
          "DELETE FROM mcp_servers WHERE id = ? AND user_id = ?"
        ).run(Number(args.id), userId);
        return JSON.stringify({ ok: true });
      }
      default:
        return `Unknown tool: ${name}`;
    }
  }

  return { tools, execute, createdFiles };
}
