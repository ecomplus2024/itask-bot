"use client";

import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import SkillsPanel from "./SkillsPanel";
import McpPanel from "./McpPanel";
import KnowledgePanel from "./KnowledgePanel";
import { BOT_ICONS } from "./BotAvatar";

export type BotData = {
  id: number;
  name: string;
  role: string;
  avatar: string;
  system_prompt: string;
  ai_base_url: string | null;
  ai_model: string | null;
  has_api_key: number;
  proactive_minutes: number;
};

type Memory = {
  id: number;
  kind: "core" | "note" | "log";
  topic: string | null;
  content: string;
  created_at: string;
};

type PromptSection = {
  id: string;
  label: string;
  bytes: number;
  tokens: number;
  text: string;
};

type Task = {
  id: number;
  instruction: string;
  interval_minutes: number | null;
  cron_expr: string | null;
  timezone: string | null;
  next_run_at: string;
  last_run_at: string | null;
  enabled: number;
  room_name: string | null;
};

const inputCls =
  "w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-zinc-500";

const TABS = [
  "general",
  "knowledge",
  "skills",
  "mcp",
  "memories",
  "tasks",
  "prompt",
] as const;
type Tab = (typeof TABS)[number];

export default function BotDialog({
  bot,
  onClose,
  onSaved,
}: {
  bot: BotData | null; // null = create new
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useT();
  const [tab, setTab] = useState<Tab>("general");
  const [form, setForm] = useState({
    name: "",
    role: "",
    avatar: "🤖",
    systemPrompt: "",
    aiBaseUrl: "",
    aiApiKey: "",
    aiModel: "",
    proactiveMinutes: 0,
  });
  const [memories, setMemories] = useState<Memory[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [promptInfo, setPromptInfo] = useState<{
    model: string;
    room_id: number;
    sections: PromptSection[];
    est_tokens: number;
  } | null>(null);
  const [promptLoading, setPromptLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [botId, setBotId] = useState<number | null>(bot?.id ?? null);

  useEffect(() => {
    if (bot) {
      setForm({
        name: bot.name,
        role: bot.role,
        avatar: bot.avatar,
        systemPrompt: bot.system_prompt,
        aiBaseUrl: bot.ai_base_url ?? "",
        aiApiKey: "",
        aiModel: bot.ai_model ?? "",
        proactiveMinutes: bot.proactive_minutes ?? 0,
      });
      fetch(`/api/bots/${bot.id}/memories`)
        .then((r) => r.json())
        .then((d) => setMemories(d.memories ?? []));
      fetch(`/api/bots/${bot.id}/tasks`)
        .then((r) => r.json())
        .then((d) => setTasks(d.tasks ?? []));
    }
  }, [bot]);

  // Lazy-load the prompt preview ("what the model sees") on first open.
  useEffect(() => {
    if (tab !== "prompt" || !botId || promptInfo || promptLoading) return;
    setPromptLoading(true);
    fetch(`/api/bots/${botId}/prompt`)
      .then((r) => r.json())
      .then((d) => setPromptInfo(d.error ? null : d))
      .finally(() => setPromptLoading(false));
  }, [tab, botId, promptInfo, promptLoading]);

  async function save() {
    if (!form.name.trim()) return;
    setSaving(true);
    if (botId) {
      await fetch(`/api/bots/${botId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
    } else {
      const res = await fetch("/api/bots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (res.ok) setBotId((await res.json()).bot.id);
    }
    setSaving(false);
    onSaved();
  }

  async function clearMemories() {
    if (!botId) return;
    await fetch(`/api/bots/${botId}/memories`, { method: "DELETE" });
    setMemories([]);
  }

  async function deleteMemory(memId: number) {
    if (!botId) return;
    await fetch(`/api/bots/${botId}/memories?id=${memId}`, {
      method: "DELETE",
    });
    setMemories((m) => m.filter((x) => x.id !== memId));
  }

  async function cancelTask(taskId: number) {
    if (!botId) return;
    await fetch(`/api/bots/${botId}/tasks?id=${taskId}`, {
      method: "DELETE",
    });
    setTasks((ts) =>
      ts.map((x) => (x.id === taskId ? { ...x, enabled: 0 } : x))
    );
  }

  function fmtInterval(mins: number | null) {
    if (!mins) return null;
    return mins >= 60 && mins % 60 === 0
      ? `${mins / 60} ${t("hours")}`
      : `${mins} ${t("minutes")}`;
  }

  function fmtTime(s: string | null) {
    if (!s) return "—";
    const d = new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z");
    return isNaN(d.getTime()) ? s : d.toLocaleString();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl h-[30rem] flex rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <nav className="w-44 shrink-0 border-r border-zinc-200 dark:border-zinc-800 p-3 space-y-1">
          <p className="px-2 pb-2 text-xs font-semibold uppercase text-zinc-500">
            {bot ? t("editBot") : t("addBot")}
          </p>
          {TABS.map((s) => (
            <button
              key={s}
              onClick={() => setTab(s)}
              className={`w-full text-left rounded-lg px-3 py-2 text-sm ${
                tab === s
                  ? "bg-zinc-200 dark:bg-zinc-800 font-medium"
                  : "hover:bg-zinc-100 dark:hover:bg-zinc-800/60"
              }`}
            >
              {t(s)}
            </button>
          ))}
        </nav>

        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-200 dark:border-zinc-800">
            <h2 className="font-semibold">{form.name || t("addBot")}</h2>
            <button
              onClick={onClose}
              className="w-8 h-8 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              ✕
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-5">
            {tab === "general" && (
              <div className="space-y-4">
                <div className="flex gap-3">
                  <div className="w-20">
                    <label className="block text-sm font-medium mb-1">
                      {t("avatar")}
                    </label>
                    <input
                      className={inputCls}
                      value={form.avatar.startsWith("icon:") ? "" : form.avatar}
                      maxLength={4}
                      placeholder="🤖"
                      onChange={(e) =>
                        setForm({ ...form, avatar: e.target.value })
                      }
                    />
                  </div>
                  <div className="flex-1">
                    <label className="block text-sm font-medium mb-1">
                      {t("botName")}
                    </label>
                    <input
                      className={inputCls}
                      value={form.name}
                      placeholder="Linh - Kế toán"
                      onChange={(e) =>
                        setForm({ ...form, name: e.target.value })
                      }
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1.5">
                    {t("pickIcon")}
                  </label>
                  <div className="grid grid-cols-8 gap-1.5">
                    {Object.entries(BOT_ICONS).map(([key, Icon]) => {
                      const value = `icon:${key}`;
                      const active = form.avatar === value;
                      return (
                        <button
                          key={key}
                          type="button"
                          title={key}
                          onClick={() =>
                            setForm({ ...form, avatar: value })
                          }
                          className={`aspect-square rounded-lg flex items-center justify-center transition-colors ${
                            active
                              ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                              : "bg-zinc-100 dark:bg-zinc-800 text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-700"
                          }`}
                        >
                          <Icon size={18} strokeWidth={2} />
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">
                    {t("role")}
                  </label>
                  <input
                    className={inputCls}
                    value={form.role}
                    placeholder="Kế toán viên / Hỗ trợ khách hàng..."
                    onChange={(e) => setForm({ ...form, role: e.target.value })}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">
                    {t("persona")}
                  </label>
                  <textarea
                    rows={4}
                    className={`${inputCls} resize-none`}
                    value={form.systemPrompt}
                    placeholder="Bạn là Linh, nhân viên kế toán 5 năm kinh nghiệm..."
                    onChange={(e) =>
                      setForm({ ...form, systemPrompt: e.target.value })
                    }
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">
                    {t("proactive")}
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={0}
                      className={`${inputCls} w-28`}
                      value={form.proactiveMinutes}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          proactiveMinutes: Math.max(
                            0,
                            Number(e.target.value) || 0
                          ),
                        })
                      }
                    />
                    <span className="text-sm text-zinc-500">
                      {t("proactiveUnit")}
                    </span>
                  </div>
                  <p className="text-xs text-zinc-500 mt-1">
                    {t("proactiveHint")}
                  </p>
                </div>
                <details className="text-sm">
                  <summary className="cursor-pointer text-zinc-500">
                    {t("aiOverride")}
                  </summary>
                  <div className="space-y-3 pt-3">
                    <input
                      className={inputCls}
                      placeholder="Base URL"
                      value={form.aiBaseUrl}
                      onChange={(e) =>
                        setForm({ ...form, aiBaseUrl: e.target.value })
                      }
                    />
                    <input
                      type="password"
                      className={inputCls}
                      placeholder={
                        bot?.has_api_key ? "API Key (••••••••)" : "API Key"
                      }
                      value={form.aiApiKey}
                      onChange={(e) =>
                        setForm({ ...form, aiApiKey: e.target.value })
                      }
                    />
                    <input
                      className={inputCls}
                      placeholder="Model"
                      value={form.aiModel}
                      onChange={(e) =>
                        setForm({ ...form, aiModel: e.target.value })
                      }
                    />
                  </div>
                </details>
              </div>
            )}

            {tab === "knowledge" &&
              (botId ? (
                <KnowledgePanel botId={botId} />
              ) : (
                <p className="text-sm text-zinc-500 text-center py-6">
                  {t("save")} bot trước
                </p>
              ))}

            {tab === "skills" && (
              <>
                <p className="text-xs text-zinc-500 -mt-1 mb-1">
                  Danh sách dùng chung cho tất cả bot
                </p>
                <SkillsPanel />
              </>
            )}

            {tab === "mcp" && (
              <>
                <p className="text-xs text-zinc-500 -mt-1 mb-1">
                  Kết nối dùng chung cho tất cả bot
                </p>
                <McpPanel />
              </>
            )}

            {tab === "memories" && (
              <div className="space-y-2">
                {memories.length === 0 && (
                  <p className="text-sm text-zinc-500 py-4 text-center">
                    {t("noMemories")}
                  </p>
                )}
                {memories
                  .filter((m) => m.kind !== "log")
                  .map((m) => (
                  <div
                    key={m.id}
                    className="flex items-start gap-2 rounded-lg border border-zinc-200 dark:border-zinc-800 px-3 py-2"
                  >
                    <span
                      className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                        m.kind === "note"
                          ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300"
                          : m.kind === "log"
                            ? "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
                            : "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                      }`}
                    >
                      {m.kind === "note"
                        ? m.topic || t("memNote")
                        : m.kind === "log"
                          ? t("memLog")
                          : t("memCore")}
                    </span>
                    <p className="flex-1 text-sm break-words">{m.content}</p>
                    <button
                      onClick={() => deleteMemory(m.id)}
                      className="text-xs text-zinc-400 hover:text-red-500"
                    >
                      ✕
                    </button>
                  </div>
                ))}
                {memories.some((m) => m.kind !== "log") && (
                  <button
                    onClick={clearMemories}
                    className="text-xs text-red-500 hover:underline"
                  >
                    {t("clearAll")}
                  </button>
                )}
                {memories.filter((m) => m.kind === "log").length > 0 && (
                  <details className="pt-2">
                    <summary className="cursor-pointer text-xs text-zinc-500">
                      {t("memLog")} (
                      {memories.filter((m) => m.kind === "log").length})
                    </summary>
                    <div className="space-y-1.5 mt-2">
                      {memories
                        .filter((m) => m.kind === "log")
                        .map((m) => (
                          <div
                            key={m.id}
                            className="flex items-start gap-2 rounded-lg border border-zinc-200/60 dark:border-zinc-800/60 px-3 py-1.5"
                          >
                            <p className="flex-1 text-xs text-zinc-500 break-words">
                              {m.content}
                            </p>
                            <button
                              onClick={() => deleteMemory(m.id)}
                              className="text-xs text-zinc-400 hover:text-red-500"
                            >
                              ✕
                            </button>
                          </div>
                        ))}
                    </div>
                  </details>
                )}
              </div>
            )}

            {tab === "prompt" &&
              (botId ? (
                <div className="space-y-2">
                  <p className="text-xs text-zinc-500 -mt-1 mb-1">
                    {t("promptDesc")}
                    {promptInfo && (
                      <span className="ml-1 font-medium text-zinc-600 dark:text-zinc-400">
                        {promptInfo.model} · ~{promptInfo.est_tokens} tokens ·{" "}
                        {t("room")} #{promptInfo.room_id}
                      </span>
                    )}
                    <button
                      onClick={() => {
                        setPromptInfo(null);
                      }}
                      className="ml-2 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
                      title="Refresh"
                    >
                      ⟳
                    </button>
                  </p>
                  {promptLoading && (
                    <p className="text-sm text-zinc-500 py-4 text-center">…</p>
                  )}
                  {promptInfo?.sections.map((s) => (
                    <details
                      key={s.id}
                      className="rounded-lg border border-zinc-200 dark:border-zinc-800"
                    >
                      <summary className="cursor-pointer px-3 py-2 text-sm font-medium flex items-center justify-between">
                        <span>{s.label}</span>
                        <span className="text-[10px] font-normal text-zinc-400">
                          {(s.bytes / 1024).toFixed(1)} KB · ~{s.tokens} tok
                        </span>
                      </summary>
                      <pre className="px-3 pb-3 text-xs whitespace-pre-wrap break-words text-zinc-600 dark:text-zinc-400 max-h-64 overflow-y-auto">
                        {s.text}
                      </pre>
                    </details>
                  ))}
                  {!promptLoading && !promptInfo && (
                    <p className="text-sm text-zinc-500 py-4 text-center">
                      {t("promptEmpty")}
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-sm text-zinc-500 text-center py-6">
                  {t("save")} bot trước
                </p>
              ))}

            {tab === "tasks" &&
              (botId ? (
                <div className="space-y-2">
                  {tasks.length === 0 && (
                    <p className="text-sm text-zinc-500 py-4 text-center">
                      {t("noTasks")}
                    </p>
                  )}
                  {tasks.map((task) => (
                    <div
                      key={task.id}
                      className={`rounded-lg border px-3 py-2 ${
                        task.enabled
                          ? "border-zinc-200 dark:border-zinc-800"
                          : "border-zinc-200/60 dark:border-zinc-800/60 opacity-50"
                      }`}
                    >
                      <div className="flex items-start gap-2">
                        <p className="flex-1 text-sm">{task.instruction}</p>
                        {task.enabled ? (
                          <button
                            onClick={() => cancelTask(task.id)}
                            className="text-xs text-zinc-400 hover:text-red-500 shrink-0"
                          >
                            {t("cancelTask")}
                          </button>
                        ) : (
                          <span className="text-xs text-zinc-400 shrink-0">
                            {t("disabled")}
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-x-3 mt-1 text-xs text-zinc-500">
                        <span>
                          {t("nextRun")}: {fmtTime(task.next_run_at)}
                        </span>
                        {task.cron_expr && (
                          <span title={task.timezone ?? ""}>
                            🔁 {task.cron_expr}
                            {task.timezone ? ` · ${task.timezone}` : ""}
                          </span>
                        )}
                        {task.interval_minutes && (
                          <span>
                            🔁 {t("every")} {fmtInterval(task.interval_minutes)}
                          </span>
                        )}
                        {task.last_run_at && (
                          <span>
                            {t("lastRun")}: {fmtTime(task.last_run_at)}
                          </span>
                        )}
                        {task.room_name && <span>💬 {task.room_name}</span>}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-zinc-500 text-center py-6">
                  {t("save")} bot trước
                </p>
              ))}
          </div>

          {tab === "general" && (
            <div className="flex justify-end px-5 py-3 border-t border-zinc-200 dark:border-zinc-800">
              <button
                onClick={save}
                disabled={saving || !form.name.trim()}
                className="rounded-lg bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 px-4 py-2 text-sm font-medium disabled:opacity-50"
              >
                {t("save")}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
