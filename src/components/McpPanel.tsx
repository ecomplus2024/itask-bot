"use client";

import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";

type Server = {
  id: number;
  name: string;
  url: string;
  headers: string;
  enabled: number;
};

type TestResult = { status: "ok"; tools: string[] } | { status: "err"; error: string };

const inputCls =
  "w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-zinc-500";

export default function McpPanel({ botId }: { botId?: number }) {
  const { t } = useT();
  const [servers, setServers] = useState<Server[]>([]);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: "", url: "", headers: "" });
  const [tests, setTests] = useState<Record<number, TestResult | "loading">>({});

  async function load() {
    const res = await fetch("/api/mcp" + (botId ? `?bot_id=${botId}` : ""));
    if (res.ok) setServers((await res.json()).servers);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botId]);

  async function add() {
    const res = await fetch("/api/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...form, botId: botId ?? null }),
    });
    if (res.ok) {
      setAdding(false);
      setForm({ name: "", url: "", headers: "" });
      load();
    }
  }

  async function toggle(s: Server) {
    await fetch(`/api/mcp/${s.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !s.enabled }),
    });
    load();
  }

  async function remove(id: number) {
    await fetch(`/api/mcp/${id}`, { method: "DELETE" });
    load();
  }

  async function test(id: number) {
    setTests((m) => ({ ...m, [id]: "loading" }));
    const res = await fetch(`/api/mcp/${id}/test`, { method: "POST" });
    const data = await res.json();
    setTests((m) => ({
      ...m,
      [id]: data.ok
        ? { status: "ok", tools: data.tools.map((t: { name: string }) => t.name) }
        : { status: "err", error: data.error ?? "unknown" },
    }));
  }

  return (
    <div className="space-y-2">
      {servers.length === 0 && !adding && (
        <p className="text-sm text-zinc-500 py-4 text-center">{t("noServers")}</p>
      )}
      {servers.map((s) => {
        const testRes = tests[s.id];
        return (
          <div
            key={s.id}
            className="rounded-lg border border-zinc-200 dark:border-zinc-800 px-3 py-2.5 space-y-1"
          >
            <div className="flex items-center gap-3">
              <input
                type="checkbox"
                checked={!!s.enabled}
                onChange={() => toggle(s)}
                className="w-4 h-4 accent-zinc-700"
              />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{s.name}</p>
                <p className="text-xs text-zinc-500 truncate">{s.url}</p>
              </div>
              <button
                onClick={() => test(s.id)}
                className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
              >
                {testRes === "loading" ? "..." : t("testConnection")}
              </button>
              <button
                onClick={() => remove(s.id)}
                className="text-xs text-zinc-500 hover:text-red-500"
              >
                {t("delete")}
              </button>
            </div>
            {testRes && testRes !== "loading" && (
              <p
                className={`text-xs pl-7 ${
                  testRes.status === "ok" ? "text-green-600" : "text-red-500"
                }`}
              >
                {testRes.status === "ok"
                  ? `${testRes.tools.length} ${t("toolsFound")}: ${testRes.tools
                      .slice(0, 5)
                      .join(", ")}${testRes.tools.length > 5 ? "..." : ""}`
                  : `${t("failed")}: ${testRes.error}`}
              </p>
            )}
          </div>
        );
      })}

      {adding ? (
        <div className="space-y-3 rounded-lg border border-zinc-200 dark:border-zinc-800 p-3">
          <input
            className={inputCls}
            placeholder={t("serverName")}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <input
            className={inputCls}
            placeholder={t("serverUrl")}
            value={form.url}
            onChange={(e) => setForm({ ...form, url: e.target.value })}
          />
          <textarea
            rows={2}
            className={`${inputCls} resize-none font-mono text-xs`}
            placeholder={t("headers")}
            value={form.headers}
            onChange={(e) => setForm({ ...form, headers: e.target.value })}
          />
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setAdding(false)}
              className="rounded-lg px-4 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              {t("cancel")}
            </button>
            <button
              onClick={add}
              disabled={!form.name.trim() || !form.url.trim()}
              className="rounded-lg bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 px-4 py-2 text-sm font-medium disabled:opacity-50"
            >
              {t("add")}
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="w-full rounded-lg border border-dashed border-zinc-300 dark:border-zinc-700 py-2 text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:border-zinc-400"
        >
          + {t("addServer")}
        </button>
      )}
    </div>
  );
}
