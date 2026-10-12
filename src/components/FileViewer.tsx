"use client";

import { useEffect, useState } from "react";
import { Download, X } from "lucide-react";

export type FileMeta = {
  id: number;
  name: string;
  mime: string;
  size: number;
  created_at: string;
  bot_name: string | null;
  room_name: string | null;
  rows?: unknown[][];
  truncated?: boolean;
};

export function fmtSize(n: number) {
  return n < 1024
    ? `${n} B`
    : n < 1048576
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1048576).toFixed(1)} MB`;
}

/**
 * Fetches and renders a file's content: HTML in a sandboxed iframe,
 * CSV/XLSX as a table, text/markdown/json as preformatted text.
 */
export default function FileViewer({ fileId }: { fileId: number }) {
  const [meta, setMeta] = useState<FileMeta | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setMeta(null);
    setText(null);
    setError("");
    fetch(`/api/files/${fileId}?format=json`)
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then(setMeta)
      .catch(() => setError("Không tìm thấy tệp"));
  }, [fileId]);

  useEffect(() => {
    if (!meta) return;
    if (
      ["text/plain", "text/markdown", "application/json"].includes(meta.mime)
    ) {
      fetch(`/api/files/${fileId}`)
        .then((r) => r.text())
        .then(setText)
        .catch(() => setText(""));
    }
  }, [meta, fileId]);

  if (error)
    return (
      <div className="h-full flex items-center justify-center text-zinc-500 text-sm">
        {error}
      </div>
    );
  if (!meta)
    return (
      <div className="h-full flex items-center justify-center text-zinc-500 text-sm">
        Đang tải…
      </div>
    );

  const isHtml = meta.mime === "text/html";
  const isImage = meta.mime.startsWith("image/");
  const isTable = meta.rows && meta.rows.length > 0;

  if (isImage) {
    return (
      <div className="h-full flex items-center justify-center p-4 bg-zinc-50 dark:bg-zinc-900">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`/api/files/${fileId}`}
          alt={meta.name}
          className="max-w-full max-h-full object-contain rounded-lg"
        />
      </div>
    );
  }
  if (isHtml) {
    return (
      // sandbox without allow-same-origin: scripts run but cannot
      // touch app cookies/APIs
      <iframe
        src={`/api/files/${fileId}`}
        sandbox="allow-scripts"
        className="w-full h-full rounded-b-xl bg-white"
      />
    );
  }
  if (isTable) {
    return (
      <div className="h-full overflow-auto">
        <table className="min-w-full text-sm">
          <thead className="sticky top-0 bg-zinc-100 dark:bg-zinc-800">
            <tr>
              {(meta.rows![0] as unknown[]).map((c, i) => (
                <th
                  key={i}
                  className="text-left font-semibold px-3 py-2 whitespace-nowrap border-b border-zinc-200 dark:border-zinc-700"
                >
                  {String(c ?? "")}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {meta.rows!.slice(1).map((r, ri) => (
              <tr
                key={ri}
                className="odd:bg-white even:bg-zinc-50 dark:odd:bg-zinc-900 dark:even:bg-zinc-800/40"
              >
                {(r as unknown[]).map((c, ci) => (
                  <td
                    key={ci}
                    className="px-3 py-1.5 whitespace-nowrap border-b border-zinc-100 dark:border-zinc-800"
                  >
                    {String(c ?? "")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {meta.truncated && (
          <p className="text-xs text-zinc-500 px-3 py-2">
            Hiển thị 500 dòng đầu — tải xuống để xem đầy đủ
          </p>
        )}
      </div>
    );
  }
  return (
    <pre className="h-full whitespace-pre-wrap text-sm p-4 overflow-auto">
      {text ?? "Đang tải…"}
    </pre>
  );
}

/** In-app modal preview of a file (opened from message attachments). */
export function FilePreviewModal({
  fileId,
  onClose,
}: {
  fileId: number;
  onClose: () => void;
}) {
  const [meta, setMeta] = useState<FileMeta | null>(null);

  useEffect(() => {
    fetch(`/api/files/${fileId}?format=json`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setMeta)
      .catch(() => {});
  }, [fileId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-4xl h-[80vh] flex flex-col rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
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
            href={`/api/files/${fileId}?download=1`}
            title="Tải xuống"
            className="p-2 rounded-lg text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            <Download size={16} />
          </a>
          <button
            onClick={onClose}
            title="Đóng"
            className="p-2 rounded-lg text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            <X size={16} />
          </button>
        </div>
        <div className="flex-1 min-h-0">
          <FileViewer fileId={fileId} />
        </div>
      </div>
    </div>
  );
}
