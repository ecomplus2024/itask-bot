"use client";

import { useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import type { VoiceStatus } from "@/lib/voice";

export default function Composer({
  onSend,
  disabled,
  large = false,
  placeholder,
  voiceStatus = "off",
  voiceInterim = "",
  voiceError = "",
  voiceThinking = false,
  onToggleVoice,
}: {
  onSend: (text: string) => void;
  disabled: boolean;
  large?: boolean;
  placeholder: string;
  voiceStatus?: VoiceStatus;
  voiceInterim?: string;
  voiceError?: string;
  voiceThinking?: boolean;
  onToggleVoice?: () => void;
}) {
  const { t } = useT();
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  function autoResize() {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }

  function submit() {
    const text = value.trim();
    if (!text || disabled) return;
    onSend(text);
    setValue("");
    requestAnimationFrame(autoResize);
  }

  const voiceOn = voiceStatus !== "off";

  return (
    <div className={`w-full ${large ? "max-w-2xl" : "max-w-3xl mx-auto"}`}>
      {voiceOn && (
        <div className="mb-2 flex items-center gap-2 rounded-full border border-zinc-200 dark:border-zinc-800 bg-white/80 dark:bg-zinc-900/80 backdrop-blur px-4 py-1.5">
          <span
            className={`w-2 h-2 rounded-full shrink-0 ${
              voiceStatus === "connecting"
                ? "bg-amber-500 animate-pulse"
                : voiceStatus === "speaking"
                  ? "bg-blue-500 animate-pulse"
                  : voiceStatus === "error"
                    ? "bg-red-500"
                    : "bg-emerald-500 animate-pulse"
            }`}
          />
          <span
            className={`text-xs truncate ${
              voiceStatus === "error" ? "text-red-500" : "text-zinc-500"
            }`}
          >
            {voiceStatus === "connecting"
              ? "…"
              : voiceStatus === "speaking"
                ? "🔊"
                : voiceStatus === "error"
                  ? voiceError || "…"
                  : voiceThinking
                    ? t("thinking")
                    : voiceInterim || t("listening")}
          </span>
        </div>
      )}
      <div className="flex items-end gap-1.5 rounded-[28px] border border-zinc-300 dark:border-zinc-700/80 bg-zinc-50 dark:bg-zinc-900 pl-1.5 pr-1.5 py-1.5 shadow-sm">
        <button
          type="button"
          title="Đính kèm (sắp có)"
          className="shrink-0 w-9 h-9 rounded-full text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-800 flex items-center justify-center"
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
        <textarea
          ref={ref}
          rows={1}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => {
            setValue(e.target.value);
            autoResize();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          className="flex-1 resize-none bg-transparent outline-none text-sm py-2 placeholder:text-zinc-400 disabled:opacity-60"
        />
        {onToggleVoice && (
          <button
            type="button"
            onClick={onToggleVoice}
            title={voiceOn ? t("voiceOff") : t("voiceOn")}
            className={`shrink-0 w-9 h-9 rounded-full flex items-center justify-center transition-colors ${
              voiceOn
                ? "bg-red-500 text-white hover:bg-red-600"
                : "text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-800"
            }`}
          >
            <svg
              width="17"
              height="17"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" y1="19" x2="12" y2="22" />
            </svg>
          </button>
        )}
        <button
          onClick={submit}
          disabled={disabled || !value.trim()}
          title={t("send")}
          className="shrink-0 w-9 h-9 rounded-full bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 flex items-center justify-center hover:opacity-90 disabled:opacity-30"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 19V5" />
            <path d="M5 12l7-7 7 7" />
          </svg>
        </button>
      </div>
    </div>
  );
}
