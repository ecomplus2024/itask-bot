"use client";

import { useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";

type Doc = {
  id: number;
  name: string;
  chunks: number;
  created_at: string;
};

const inputCls =
  "w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-zinc-500";

export default function KnowledgePanel({ botId }: { botId: number }) {
  const { t } = useT();
  const [docs, setDocs] = useState<Doc[]>([]);
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function load() {
    const res = await fetch(`/api/bots/${botId}/documents`);
    if (res.ok) setDocs((await res.json()).documents);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botId]);

  async function upload(docName: string, content: string) {
    if (!docName.trim() || !content.trim()) return;
    setBusy(true);
    await fetch(`/api/bots/${botId}/documents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: docName, content }),
    });
    setBusy(false);
    setText("");
    setName("");
    load();
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => upload(file.name, String(reader.result ?? ""));
    reader.readAsText(file);
    e.target.value = "";
  }

  async function remove(id: number) {
    await fetch(`/api/bots/${botId}/documents?id=${id}`, { method: "DELETE" });
    load();
  }

  return (
    <div className="space-y-3">
      {docs.length === 0 && (
        <p className="text-sm text-zinc-500 py-2 text-center">{t("noDocs")}</p>
      )}
      {docs.map((d) => (
        <div
          key={d.id}
          className="flex items-center gap-3 rounded-lg border border-zinc-200 dark:border-zinc-800 px-3 py-2"
        >
          <span className="text-lg">📄</span>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{d.name}</p>
            <p className="text-xs text-zinc-500">
              {d.chunks} {t("chunks")}
            </p>
          </div>
          <button
            onClick={() => remove(d.id)}
            className="text-xs text-zinc-400 hover:text-red-500"
          >
            {t("delete")}
          </button>
        </div>
      ))}

      <input
        ref={fileRef}
        type="file"
        accept=".txt,.md,.csv,.json,.log"
        className="hidden"
        onChange={onFile}
      />
      <button
        onClick={() => fileRef.current?.click()}
        disabled={busy}
        className="w-full rounded-lg border border-dashed border-zinc-300 dark:border-zinc-700 py-2 text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:border-zinc-400"
      >
        + {t("uploadDoc")}
      </button>

      <div className="space-y-2">
        <input
          className={inputCls}
          placeholder={t("docName")}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <textarea
          rows={4}
          className={`${inputCls} resize-none`}
          placeholder={t("pasteText")}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        {(text.trim() || name.trim()) && (
          <button
            onClick={() => upload(name || "Untitled", text)}
            disabled={busy || !text.trim()}
            className="rounded-lg bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 px-4 py-2 text-sm font-medium disabled:opacity-50"
          >
            {t("add")}
          </button>
        )}
      </div>
    </div>
  );
}
