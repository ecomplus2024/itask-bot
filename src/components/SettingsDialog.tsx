"use client";

import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import SkillsPanel from "./SkillsPanel";
import McpPanel from "./McpPanel";

type FormState = {
  aiBaseUrl: string;
  aiApiKey: string;
  aiModel: string;
  aiSystemPrompt: string;
  deepgramApiKey: string;
  geminiApiKey: string;
  jevApiKey: string;
};

const SECTIONS = ["aiConfig", "skills", "mcp", "update"] as const;
type Section = (typeof SECTIONS)[number];

type UpdateState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "up-to-date" }
  | { phase: "available"; version: string }
  | { phase: "downloading"; percent: number }
  | { phase: "ready"; version: string }
  | { phase: "error"; message: string };

export default function SettingsDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useT();
  const [section, setSection] = useState<Section>("aiConfig");
  const [form, setForm] = useState<FormState>({
    aiBaseUrl: "",
    aiApiKey: "",
    aiModel: "",
    aiSystemPrompt: "",
    deepgramApiKey: "",
    geminiApiKey: "",
    jevApiKey: "",
  });
  const [defaults, setDefaults] = useState<{
    aiBaseUrl: string;
    aiModel: string;
    aiSystemPrompt: string;
    hasEnvKey: boolean;
    hasDgKey?: boolean;
    hasGeminiKey?: boolean;
    hasJevKey?: boolean;
  } | null>(null);
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [version, setVersion] = useState("");
  const [upd, setUpd] = useState<UpdateState>({ phase: "idle" });
  const isDesktop =
    typeof window !== "undefined" && !!(window as any).itaskDesktop;

  useEffect(() => {
    if (!open || !isDesktop) return;
    const d = (window as any).itaskDesktop;
    d.getVersion?.().then(setVersion).catch(() => {});
    const off = d.onUpdateEvent?.((ev: any) => {
      if (ev.type === "checking") setUpd({ phase: "checking" });
      else if (ev.type === "not-available") setUpd({ phase: "up-to-date" });
      else if (ev.type === "available")
        setUpd({ phase: "available", version: ev.version });
      else if (ev.type === "progress")
        setUpd({ phase: "downloading", percent: ev.percent });
      else if (ev.type === "downloaded")
        setUpd({ phase: "ready", version: ev.version });
      else if (ev.type === "error")
        setUpd({ phase: "error", message: ev.message });
    });
    return off;
  }, [open, isDesktop]);

  useEffect(() => {
    if (!open) return;
    setStatus("idle");
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data) => {
        setDefaults(data.defaults);
        setForm({
          aiBaseUrl: data.settings.aiBaseUrl,
          aiApiKey: data.settings.aiApiKey ?? "",
          aiModel: data.settings.aiModel,
          aiSystemPrompt: data.settings.aiSystemPrompt,
          deepgramApiKey: data.settings.deepgramApiKey ?? "",
          geminiApiKey: data.settings.geminiApiKey ?? "",
          jevApiKey: data.settings.jevApiKey ?? "",
        });
      });
  }, [open]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    if (open) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  async function save() {
    setStatus("saving");
    await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    setStatus("saved");
    setTimeout(() => setStatus("idle"), 2000);
  }

  const set = (k: keyof FormState) => (v: string) =>
    setForm((f) => ({ ...f, [k]: v }));

  const inputCls =
    "w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-zinc-500";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl h-[28rem] flex rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Left nav */}
        <nav className="w-44 shrink-0 border-r border-zinc-200 dark:border-zinc-800 p-3 space-y-1">
          <p className="px-2 pb-2 text-xs font-semibold uppercase text-zinc-500">
            {t("settings")}
          </p>
          {SECTIONS.filter((s) => s !== "update" || isDesktop).map((s) => (
            <button
              key={s}
              onClick={() => setSection(s)}
              className={`w-full text-left rounded-lg px-3 py-2 text-sm ${
                section === s
                  ? "bg-zinc-200 dark:bg-zinc-800 font-medium"
                  : "hover:bg-zinc-100 dark:hover:bg-zinc-800/60"
              }`}
            >
              {t(s)}
            </button>
          ))}
        </nav>

        {/* Content */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-200 dark:border-zinc-800">
            <h2 className="font-semibold">{t(section)}</h2>
            <button
              onClick={onClose}
              className="w-8 h-8 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800"
              title={t("close")}
            >
              ✕
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-5">
            {section === "update" && (
              <div className="space-y-4">
                <div className="flex items-center justify-between rounded-xl border border-zinc-200 dark:border-zinc-800 px-4 py-3">
                  <div>
                    <p className="text-sm text-zinc-500">{t("appVersion")}</p>
                    <p className="font-medium">v{version || "…"}</p>
                  </div>
                  {upd.phase === "checking" ? (
                    <span className="text-sm text-zinc-500">{t("checking")}</span>
                  ) : upd.phase === "up-to-date" ? (
                    <span className="text-sm text-green-600">{t("upToDate")}</span>
                  ) : upd.phase === "available" ? (
                    <button
                      onClick={() => (window as any).itaskDesktop.downloadUpdate()}
                      className="rounded-lg bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 px-4 py-2 text-sm font-medium hover:opacity-90"
                    >
                      {t("newVersionFound")} v{upd.version} — {t("downloadUpdate")}
                    </button>
                  ) : upd.phase === "downloading" ? (
                    <span className="text-sm text-zinc-500">
                      {t("downloading")} {upd.percent}%
                    </span>
                  ) : upd.phase === "ready" ? (
                    <button
                      onClick={() => (window as any).itaskDesktop.installUpdate()}
                      className="rounded-lg bg-green-600 text-white px-4 py-2 text-sm font-medium hover:opacity-90"
                    >
                      {t("restartToUpdate")}
                    </button>
                  ) : upd.phase === "error" ? (
                    <span className="text-sm text-red-500" title={upd.message}>
                      {t("updateFailed")}
                    </span>
                  ) : (
                    <button
                      onClick={() => (window as any).itaskDesktop.checkUpdate()}
                      className="rounded-lg bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 px-4 py-2 text-sm font-medium hover:opacity-90"
                    >
                      {t("checkUpdate")}
                    </button>
                  )}
                </div>
                {upd.phase === "downloading" && (
                  <div className="h-1.5 rounded-full bg-zinc-200 dark:bg-zinc-800 overflow-hidden">
                    <div
                      className="h-full bg-zinc-900 dark:bg-zinc-100 transition-all"
                      style={{ width: `${upd.percent}%` }}
                    />
                  </div>
                )}
              </div>
            )}
            {section === "skills" && <SkillsPanel />}
            {section === "mcp" && <McpPanel />}
            {section === "aiConfig" && (
            <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1">
                {t("baseUrl")}
              </label>
              <input
                className={inputCls}
                value={form.aiBaseUrl}
                placeholder={defaults?.aiBaseUrl ?? "https://api.openai.com/v1"}
                onChange={(e) => set("aiBaseUrl")(e.target.value)}
              />
              <p className="mt-1 text-xs text-zinc-500">
                {t("leaveEmptyForDefault")}
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">
                {t("apiKey")}
              </label>
              <input
                type="password"
                className={inputCls}
                value={form.aiApiKey}
                placeholder={
                  defaults?.hasEnvKey ? "••••••••" : "sk-..."
                }
                onChange={(e) => set("aiApiKey")(e.target.value)}
              />
              <p className="mt-1 text-xs text-zinc-500">
                {t("keepCurrentKey")}
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">
                {t("model")}
              </label>
              <input
                className={inputCls}
                value={form.aiModel}
                placeholder={defaults?.aiModel ?? "gpt-4o-mini"}
                onChange={(e) => set("aiModel")(e.target.value)}
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">
                {t("systemPrompt")}
              </label>
              <textarea
                rows={4}
                className={`${inputCls} resize-none`}
                value={form.aiSystemPrompt}
                placeholder={defaults?.aiSystemPrompt}
                onChange={(e) => set("aiSystemPrompt")(e.target.value)}
              />
            </div>

            <div className="pt-2 border-t border-zinc-200 dark:border-zinc-800">
              <label className="block text-sm font-medium mb-1">
                {t("deepgramKey")}
              </label>
              <input
                type="password"
                className={inputCls}
                value={form.deepgramApiKey}
                placeholder={defaults?.hasDgKey ? "••••••••" : "Token from console.deepgram.com"}
                onChange={(e) => set("deepgramApiKey")(e.target.value)}
              />
              <p className="mt-1 text-xs text-zinc-500">
                {t("deepgramHint")}
              </p>
            </div>

            <div className="pt-2 border-t border-zinc-200 dark:border-zinc-800">
              <label className="block text-sm font-medium mb-1">
                {t("geminiKey")}
              </label>
              <input
                type="password"
                className={inputCls}
                value={form.geminiApiKey}
                placeholder={defaults?.hasGeminiKey ? "••••••••" : "Key from aistudio.google.com"}
                onChange={(e) => set("geminiApiKey")(e.target.value)}
              />
              <p className="mt-1 text-xs text-zinc-500">
                {t("geminiHint")}
              </p>
            </div>

            <div className="pt-2 border-t border-zinc-200 dark:border-zinc-800">
              <label className="block text-sm font-medium mb-1">
                {t("jevKey")}
              </label>
              <input
                type="password"
                className={inputCls}
                value={form.jevApiKey}
                placeholder={defaults?.hasJevKey ? "••••••••" : "Key from console.typesafe.ai"}
                onChange={(e) => set("jevApiKey")(e.target.value)}
              />
              <p className="mt-1 text-xs text-zinc-500">
                {t("jevHint")}
              </p>
            </div>
            </div>
            )}
          </div>

          {section === "aiConfig" && (
          <div className="flex justify-end gap-2 px-5 py-3 border-t border-zinc-200 dark:border-zinc-800">
            {status === "saved" && (
              <span className="self-center text-sm text-green-600">
                {t("saved")}
              </span>
            )}
            <button
              onClick={save}
              disabled={status === "saving"}
              className="rounded-lg bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 px-4 py-2 text-sm font-medium hover:opacity-90 disabled:opacity-50"
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
