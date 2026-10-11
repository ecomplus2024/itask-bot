import crypto from "crypto";
import db from "./db";

export type McpServer = {
  id: number;
  name: string;
  url: string;
  headers: Record<string, string>;
};

type RpcResult = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
  sessionId: string | null;
};

async function rpc(
  server: McpServer,
  method: string,
  params: unknown,
  sessionId: string | null,
  isNotification = false
): Promise<RpcResult> {
  const res = await fetch(server.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      ...server.headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      ...(isNotification ? {} : { id: crypto.randomUUID() }),
      method,
      params,
    }),
  });

  const newSession = res.headers.get("mcp-session-id") ?? sessionId;
  if (isNotification || res.status === 202) {
    await res.arrayBuffer().catch(() => {});
    return { data: null, sessionId: newSession };
  }

  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("text/event-stream")) {
    const text = await res.text();
    const dataLines = text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .filter(Boolean);
    if (!dataLines.length) throw new Error("Empty SSE response from MCP server");
    return {
      data: JSON.parse(dataLines[dataLines.length - 1]),
      sessionId: newSession,
    };
  }
  return { data: await res.json(), sessionId: newSession };
}

async function initSession(server: McpServer): Promise<string | null> {
  const { sessionId, data } = await rpc(
    server,
    "initialize",
    {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "itask-bot", version: "0.1.0" },
    },
    null
  );
  if (data?.error) throw new Error(data.error.message ?? "MCP init failed");
  await rpc(server, "notifications/initialized", {}, sessionId, true);
  return sessionId;
}

export async function listTools(
  server: McpServer
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any[]> {
  const sessionId = await initSession(server);
  const { data } = await rpc(server, "tools/list", {}, sessionId);
  if (data?.error) throw new Error(data.error.message ?? "tools/list failed");
  return data?.result?.tools ?? [];
}

export async function callTool(
  server: McpServer,
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  const sessionId = await initSession(server);
  const { data } = await rpc(
    server,
    "tools/call",
    { name, arguments: args },
    sessionId
  );
  if (data?.error) throw new Error(data.error.message ?? "tools/call failed");
  const result = data?.result;
  if (result?.content) {
    return result.content
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((c: any) => (c.type === "text" ? c.text : JSON.stringify(c)))
      .join("\n");
  }
  return JSON.stringify(result ?? {});
}

function sanitize(name: string) {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 24);
}

// All enabled MCP servers are shared across every bot of this user
export function getEnabledServers(userId: number): McpServer[] {
  const rows = db
    .prepare(
      `SELECT id, name, url, headers FROM mcp_servers
       WHERE user_id = ? AND enabled = 1
       ORDER BY id`
    )
    .all(userId) as {
    id: number;
    name: string;
    url: string;
    headers: string;
  }[];
  return rows.map((r) => {
    let headers: Record<string, string> = {};
    try {
      headers = JSON.parse(r.headers);
    } catch {
      // ignore malformed headers
    }
    return { id: r.id, name: r.name, url: r.url, headers };
  });
}

export type OpenAITool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

/**
 * Collects tools from all enabled MCP servers of a user.
 * Returns OpenAI-format tool defs + an executor that routes
 * a tool_call back to the right server.
 */
export async function getMcpTools(
  userId: number
): Promise<{
  tools: OpenAITool[];
  execute: (name: string, args: Record<string, unknown>) => Promise<string>;
}> {
  const servers = getEnabledServers(userId);
  const tools: OpenAITool[] = [];
  const routes = new Map<string, { server: McpServer; tool: string }>();

  for (const server of servers) {
    try {
      const list = await listTools(server);
      for (const tool of list) {
        const fnName = `${sanitize(server.name)}__${sanitize(tool.name)}`;
        routes.set(fnName, { server, tool: tool.name });
        tools.push({
          type: "function",
          function: {
            name: fnName,
            description:
              tool.description ?? `Tool ${tool.name} from ${server.name}`,
            parameters: tool.inputSchema ?? { type: "object", properties: {} },
          },
        });
      }
    } catch {
      // skip unreachable server, don't break chat
    }
  }

  return {
    tools,
    execute: async (name, args) => {
      const route = routes.get(name);
      if (!route) return `Unknown tool: ${name}`;
      try {
        return await callTool(route.server, route.tool, args);
      } catch (e) {
        return `Tool error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  };
}
