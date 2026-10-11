"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import FileViewer, { FileMeta, fmtSize } from "@/components/FileViewer";

export default function FileViewerPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [meta, setMeta] = useState<FileMeta | null>(null);

  useEffect(() => {
    fetch(`/api/files/${id}?format=json`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setMeta)
      .catch(() => {});
  }, [id]);

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 flex flex-col">
      <header className="flex items-center gap-3 px-5 py-3 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
        <Link
          href="/chat"
          className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 text-sm"
        >
          ←
        </Link>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold truncate">
            {meta?.name ?? "Đang tải…"}
          </p>
          {meta && (
            <p className="text-xs text-zinc-500">
              {meta.bot_name ? `${meta.bot_name} · ` : ""}
              {fmtSize(meta.size)} · {meta.created_at}
            </p>
          )}
        </div>
        <a
          href={`/api/files/${id}?download=1`}
          className="rounded-lg bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 text-sm px-3.5 py-1.5 hover:opacity-85"
        >
          Tải xuống
        </a>
      </header>
      <main className="flex-1 min-h-0 p-4">
        <div className="h-full rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden">
          <FileViewer fileId={Number(id)} />
        </div>
      </main>
    </div>
  );
}
