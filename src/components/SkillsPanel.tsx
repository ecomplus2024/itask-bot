"use client";

import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";

type Skill = {
  id: number;
  name: string;
  description: string;
  content: string;
  enabled: number;
};

const inputCls =
  "w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-zinc-500";

export default function SkillsPanel({ botId }: { botId?: number }) {
  const { t } = useT();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [editing, setEditing] = useState<Skill | "new" | null>(null);
  const [form, setForm] = useState({ name: "", description: "", content: "" });

  async function load() {
    const res = await fetch("/api/skills" + (botId ? `?bot_id=${botId}` : ""));
    if (res.ok) setSkills((await res.json()).skills);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botId]);

  function startEdit(s: Skill | "new") {
    setEditing(s);
    setForm(
      s === "new"
        ? { name: "", description: "", content: "" }
        : { name: s.name, description: s.description, content: s.content }
    );
  }

  async function save() {
    if (editing === "new") {
      await fetch("/api/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, botId: botId ?? null }),
      });
    } else if (editing) {
      await fetch(`/api/skills/${editing.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
    }
    setEditing(null);
    load();
  }

  async function toggle(s: Skill) {
    await fetch(`/api/skills/${s.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !s.enabled }),
    });
    load();
  }

  async function remove(id: number) {
    await fetch(`/api/skills/${id}`, { method: "DELETE" });
    load();
  }

  if (editing) {
    return (
      <div className="space-y-3">
        <input
          className={inputCls}
          placeholder={t("skillName")}
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
        <input
          className={inputCls}
          placeholder={t("skillDesc")}
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
        />
        <textarea
          rows={8}
          className={`${inputCls} resize-none`}
          placeholder={t("skillContent")}
          value={form.content}
          onChange={(e) => setForm({ ...form, content: e.target.value })}
        />
        <div className="flex justify-end gap-2">
          <button
            onClick={() => setEditing(null)}
            className="rounded-lg px-4 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            {t("cancel")}
          </button>
          <button
            onClick={save}
            disabled={!form.name.trim() || !form.content.trim()}
            className="rounded-lg bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 px-4 py-2 text-sm font-medium disabled:opacity-50"
          >
            {t("save")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {skills.length === 0 && (
        <p className="text-sm text-zinc-500 py-4 text-center">{t("noSkills")}</p>
      )}
      {skills.map((s) => (
        <div
          key={s.id}
          className="flex items-center gap-3 rounded-lg border border-zinc-200 dark:border-zinc-800 px-3 py-2.5"
        >
          <input
            type="checkbox"
            checked={!!s.enabled}
            onChange={() => toggle(s)}
            className="w-4 h-4 accent-zinc-700"
          />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{s.name}</p>
            {s.description && (
              <p className="text-xs text-zinc-500 truncate">{s.description}</p>
            )}
          </div>
          <button
            onClick={() => startEdit(s)}
            className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
          >
            {t("edit")}
          </button>
          <button
            onClick={() => remove(s.id)}
            className="text-xs text-zinc-500 hover:text-red-500"
          >
            {t("delete")}
          </button>
        </div>
      ))}
      <button
        onClick={() => startEdit("new")}
        className="w-full rounded-lg border border-dashed border-zinc-300 dark:border-zinc-700 py-2 text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:border-zinc-400"
      >
        + {t("addSkill")}
      </button>
    </div>
  );
}
