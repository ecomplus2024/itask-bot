"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useT } from "@/lib/i18n";
import BotAvatar, { botColor } from "./BotAvatar";
import { FilePreviewModal } from "./FileViewer";
import {
  File as FileIcon,
  FileSpreadsheet,
  FileCode,
  FileJson,
  FileText,
} from "lucide-react";

export { botColor };

function fileIcon(name: string) {
  const ext = name.split(".").pop()?.toLowerCase();
  if (ext === "csv" || ext === "xlsx") return FileSpreadsheet;
  if (ext === "html") return FileCode;
  if (ext === "json") return FileJson;
  if (ext === "md" || ext === "txt") return FileText;
  return FileIcon;
}

export type RoomMsg = {
  id?: number;
  kind: "user" | "bot";
  sender_id: number;
  sender_name: string;
  avatar?: string;
  content: string;
  streaming?: boolean;
  created_at?: string;
};

function fmtTime(s?: string) {
  if (!s) return "";
  const d = new Date(s.replace(" ", "T") + "Z");
  return isNaN(d.getTime())
    ? ""
    : d.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
}

function TypingDots() {
  const { t } = useT();
  return (
    <span
      className="typing-dots text-zinc-400"
      role="status"
      aria-label={t("thinking")}
    >
      <span />
      <span />
      <span />
    </span>
  );
}

export default function RoomMessageList({
  messages,
  streaming,
  thinkingBot,
}: {
  messages: RoomMsg[];
  streaming: boolean;
  thinkingBot?: { id: number; name: string; avatar?: string };
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [previewFileId, setPreviewFileId] = useState<number | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "instant" });
  }, [messages]);

  return (
    <div className="flex-1 overflow-y-auto px-4">
      <div className="max-w-3xl mx-auto pt-16 pb-6">
        {messages.map((m, i) => {
          const isUser = m.kind === "user";
          const sameSender = (a?: RoomMsg, b?: RoomMsg) =>
            !!a && !!b && a.kind === b.kind && a.sender_id === b.sender_id;
          // Consecutive messages from one sender form a group: sender
          // name on the first, avatar + timestamp on the last.
          const isFirst = !sameSender(messages[i - 1], m);
          const isGroupEnd = !sameSender(m, messages[i + 1]);
          const isLast = i === messages.length - 1;
          return (
            <div
              key={m.id ?? `s${i}`}
              className={`flex gap-3 ${isUser ? "flex-row-reverse" : ""} ${
                isFirst ? (i === 0 ? "" : "mt-5") : "mt-1"
              }`}
            >
              {!isUser &&
                (isGroupEnd ? (
                  <BotAvatar
                    avatar={m.avatar ?? m.sender_name.charAt(0).toUpperCase()}
                    botId={m.sender_id}
                    size={32}
                  />
                ) : (
                  <div className="w-8 shrink-0" />
                ))}
              <div className={`min-w-0 ${isUser ? "max-w-[80%]" : "flex-1"}`}>
                {!isUser && isFirst && (
                  <p className="text-xs font-semibold text-zinc-500 mb-0.5">
                    {m.sender_name}
                  </p>
                )}
                <div
                  className={
                    isUser
                      ? "rounded-2xl rounded-br-md bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 px-4 py-2.5 whitespace-pre-wrap text-sm"
                      : "prose-chat text-sm leading-relaxed rounded-2xl rounded-tl-md bg-zinc-100 dark:bg-zinc-800/70 px-4 py-3 max-w-[92%]"
                  }
                >
                  {isUser ? (
                    m.content
                  ) : (
                    <>
                      {m.content ? (
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          components={{
                            a: ({ href, children }) => {
                              const m2 = href?.match(/^\/files\/(\d+)/);
                              if (m2) {
                                const fid = Number(m2[1]);
                                const label = String(children ?? "file");
                                const Icon = fileIcon(label);
                                return (
                                  <a
                                    href={href}
                                    onClick={(e) => {
                                      e.preventDefault();
                                      setPreviewFileId(fid);
                                    }}
                                    className="inline-flex items-center gap-2 rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-1.5 my-0.5 text-sm font-medium hover:border-zinc-400 dark:hover:border-zinc-500 cursor-pointer no-underline"
                                  >
                                    <Icon
                                      size={16}
                                      className="text-zinc-500 shrink-0"
                                    />
                                    <span className="truncate max-w-48">
                                      {children}
                                    </span>
                                  </a>
                                );
                              }
                              return (
                                <a
                                  href={href}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="text-sky-600 dark:text-sky-400 underline"
                                >
                                  {children}
                                </a>
                              );
                            },
                          }}
                        >
                          {m.content}
                        </ReactMarkdown>
                      ) : m.streaming ? (
                        <TypingDots />
                      ) : null}
                      {m.streaming && m.content && isLast && (
                        <span className="cursor-blink inline-block w-2 h-4 bg-zinc-400 ml-0.5 align-middle" />
                      )}
                    </>
                  )}
                </div>
                {isGroupEnd && fmtTime(m.created_at) && (
                  <p
                    className={`text-[10px] text-zinc-400 mt-0.5 ${
                      isUser ? "text-right" : ""
                    }`}
                  >
                    {fmtTime(m.created_at)}
                  </p>
                )}
              </div>
            </div>
          );
        })}
        {streaming && !messages[messages.length - 1]?.streaming && (
          <div className="flex gap-3">
            {thinkingBot ? (
              <>
                <BotAvatar
                  avatar={
                    thinkingBot.avatar ??
                    thinkingBot.name.charAt(0).toUpperCase()
                  }
                  botId={thinkingBot.id}
                  size={32}
                />
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-zinc-500 mb-0.5">
                    {thinkingBot.name}
                  </p>
                  <TypingDots />
                </div>
              </>
            ) : (
              <>
                <div className="w-8 h-8 shrink-0" />
                <TypingDots />
              </>
            )}
          </div>
        )}
        <div ref={bottomRef} />
      </div>
      {previewFileId !== null && (
        <FilePreviewModal
          fileId={previewFileId}
          onClose={() => setPreviewFileId(null)}
        />
      )}
    </div>
  );
}
