"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type FileItem = {
  id: number;
  name: string;
  mime: string;
  size: number;
  created_at: string;
  bot_name: string | null;
  room_name: string | null;
};

const ICONS: Record<string, string> = {
  "text/csv": "📊",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "📊",
  "text/html": "🌐",
  "text/markdown": "📝",
  "application/json": "🧾",
};

function fmtSize(n: number) {
  return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}

export default function FilesPage() {
  const [files, setFiles] = useState<FileItem[] | null>(null);

  useEffect(() => {
    fetch("/api/files")
      .then((r) => r.json())
      .then((d) => setFiles(d.files ?? []))
      .catch(() => setFiles([]));
  }, []);

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <header className="flex items-center gap-3 px-5 py-3 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
        <Link
          href="/chat"
          className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
        >
          ←
        </Link>
        <p className="text-sm font-semibold">Tệp đã tạo</p>
      </header>
      <main className="max-w-3xl mx-auto p-5">
        {files === null ? (
          <p className="text-sm text-zinc-500">Đang tải…</p>
        ) : files.length === 0 ? (
          <p className="text-sm text-zinc-500">
            Chưa có tệp nào — bảo bot tạo báo cáo/xuất file để xem ở đây.
          </p>
        ) : (
          <div className="space-y-2">
            {files.map((f) => (
              <Link
                key={f.id}
                href={`/files/${f.id}`}
                className="flex items-center gap-3 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-4 py-3 hover:border-zinc-400 dark:hover:border-zinc-600 transition-colors"
              >
                <span className="text-xl">{ICONS[f.mime] ?? "📄"}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{f.name}</p>
                  <p className="text-xs text-zinc-500">
                    {f.bot_name ? `${f.bot_name} · ` : ""}
                    {f.room_name ? `${f.room_name} · ` : ""}
                    {fmtSize(f.size)} · {f.created_at}
                  </p>
                </div>
                <span className="text-zinc-400">→</span>
              </Link>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
