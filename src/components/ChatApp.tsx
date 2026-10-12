"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/lib/i18n";
import { ChevronLeft, Minus, Square, X } from "lucide-react";
import Composer from "./Composer";
import RoomMessageList, { RoomMsg } from "./RoomMessageList";
import BotAvatar from "./BotAvatar";
import BotDialog, { BotData } from "./BotDialog";
import SettingsDialog from "./SettingsDialog";
import { VoiceSession, type VoiceStatus } from "@/lib/voice";

type Bot = {
  id: number;
  name: string;
  role: string;
  avatar: string;
  thinking?: boolean;
};

type Room = {
  id: number;
  name: string;
  direct_bot_id: number | null;
  kind?: string;
  updated_at: string;
  bots: Bot[];
};

export default function ChatApp({
  user,
}: {
  user: { id: number; email: string; name: string };
}) {
  const { t, lang, setLang } = useT();
  const router = useRouter();
  const [bots, setBots] = useState<Bot[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [activeRoom, setActiveRoom] = useState<Room | null>(null);
  const [messages, setMessages] = useState<RoomMsg[]>([]);
  const [streaming, setStreaming] = useState(false);

  const [botDialog, setBotDialog] = useState<BotData | null | "new">(null);
  const [roomDialog, setRoomDialog] = useState<"new" | Room | null>(null);
  const [roomName, setRoomName] = useState("");
  const [roomBotIds, setRoomBotIds] = useState<Set<number>>(new Set());
  const [directBotId, setDirectBotId] = useState<number | null>(null);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dark, setDark] = useState(false);
  const [isDesktop, setIsDesktop] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>("off");
  const [voiceInterim, setVoiceInterim] = useState("");
  const voiceRef = useRef<VoiceSession | null>(null);

  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
    setIsDesktop(!!(window as any).itaskDesktop);
  }, []);

  function toggleTheme() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("itask-theme", next ? "dark" : "light");
  }
  const abortRef = useRef<AbortController | null>(null);

  const loadBots = useCallback(async () => {
    const res = await fetch("/api/bots");
    if (res.ok) setBots((await res.json()).bots);
  }, []);

  const loadRooms = useCallback(async () => {
    const res = await fetch("/api/rooms");
    if (res.ok) {
      const data = await res.json();
      setRooms(data.rooms);
      setActiveRoom((cur) =>
        cur ? data.rooms.find((r: Room) => r.id === cur.id) ?? cur : cur
      );
    }
  }, []);

  useEffect(() => {
    loadBots();
    loadRooms();
    const iv = setInterval(loadBots, 4000);
    return () => clearInterval(iv);
  }, [loadBots, loadRooms]);

  useEffect(() => {
    if (!directBotId || !bots.some((b) => b.id === directBotId)) {
      setDirectBotId(bots[0]?.id ?? null);
    }
  }, [bots, directBotId]);

  const roomThinking =
    activeRoom?.bots.some((rb) =>
      bots.find((b) => b.id === rb.id)?.thinking
    ) ?? false;
  const loadMessages = useCallback(
    async (room: Room) => {
      const res = await fetch(`/api/rooms/${room.id}/messages`);
      if (!res.ok) return;
      const data = await res.json();
      const mapped = data.messages.map((m: RoomMsg) => ({
        ...m,
        avatar: room.bots.find((b) => b.id === m.sender_id)?.avatar,
      }));
      // Skip setState when nothing changed — keeps scroll position and
      // avoids pointless re-renders during background polling.
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        const next = mapped[mapped.length - 1];
        return prev.length === mapped.length && last?.id === next?.id
          ? prev
          : mapped;
      });
    },
    []
  );

  async function openRoom(room: Room) {
    abortRef.current?.abort();
    setActiveRoom(room);
    setMessages([]);
    await loadMessages(room);
  }

  // On first load, jump straight into the most recent conversation
  // instead of showing the bot-picker welcome screen.
  const autoOpened = useRef(false);
  useEffect(() => {
    if (autoOpened.current || activeRoom || rooms.length === 0) return;
    autoOpened.current = true;
    // On mobile the list IS the home screen — don't jump into a chat.
    if (window.innerWidth < 768) return;
    openRoom(rooms.find((r) => r.kind !== "bot_dm") ?? rooms[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rooms, activeRoom]);

  // Real-time push via the embedded WebSocket server: subscribe to the
  // open room and reload messages the instant the server saves one
  // (scheduled tasks, proactive runs, cross-room bot messages, other
  // devices). A slow poll remains as fallback when the WS is unreachable.
  const wsRef = useRef<WebSocket | null>(null);
  const activeRoomRef = useRef<Room | null>(null);
  activeRoomRef.current = activeRoom;
  const loadMessagesRef = useRef(loadMessages);
  loadMessagesRef.current = loadMessages;

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout>;
    let stopped = false;
    function connect() {
      if (stopped) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const wsPort = (window as any).itaskDesktop?.wsPort || 3001;
      ws = new WebSocket(`${proto}://${location.hostname}:${wsPort}`);
      wsRef.current = ws;
      ws.onopen = () => {
        const room = activeRoomRef.current;
        if (room) ws?.send(JSON.stringify({ subscribe: room.id }));
      };
      ws.onmessage = (e) => {
        try {
          const ev = JSON.parse(e.data);
          const room = activeRoomRef.current;
          if (ev.type === "refresh" && room && ev.roomId === room.id) {
            loadMessagesRef.current(room);
          }
        } catch {
          // ignore malformed frames
        }
      };
      ws.onclose = () => {
        wsRef.current = null;
        if (!stopped) retry = setTimeout(connect, 3000);
      };
    }
    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      ws?.close();
      wsRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (activeRoom && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ subscribe: activeRoom.id }));
    }
  }, [activeRoom]);

  // Fallback poll while the WS is down (and to catch edge cases).
  useEffect(() => {
    if (!activeRoom || streaming) return;
    const iv = setInterval(
      () => loadMessages(activeRoom),
      roomThinking ? 2500 : 10000
    );
    return () => clearInterval(iv);
  }, [activeRoom, streaming, roomThinking, loadMessages]);

  // --- Voice conversation (Deepgram STT + browser TTS) ----------------
  // Free-speech mode: the session streams mic audio continuously,
  // Deepgram's endpointing detects turn boundaries, finals are posted
  // as room messages, bot replies are spoken via speechSynthesis.
  const sendRef = useRef<(text: string) => void>(() => {});
  sendRef.current = (text) => send(text);
  const streamingRef = useRef(false);
  streamingRef.current = streaming;

  function toggleVoice() {
    if (voiceRef.current) {
      voiceRef.current.stop();
      voiceRef.current = null;
      return;
    }
    const session = new VoiceSession({
      onStatus: setVoiceStatus,
      onInterim: setVoiceInterim,
      onFinal: (text) => sendRef.current(text),
      onError: (msg) => {
        if (msg === "no_deepgram_key" || msg === "mic_denied")
          setSettingsOpen(true);
      },
    });
    voiceRef.current = session;
    session.start();
  }

  // Stop voice when switching rooms or leaving the page.
  useEffect(() => {
    return () => {
      voiceRef.current?.stop();
      voiceRef.current = null;
    };
  }, [activeRoom?.id]);

  // Speak the bot's reply once streaming settles and the last message
  // is a finished bot message.
  const prevStreaming = useRef(false);
  useEffect(() => {
    const wasStreaming = prevStreaming.current;
    prevStreaming.current = streaming;
    if (!wasStreaming || streaming) return;
    const last = messages[messages.length - 1];
    if (voiceRef.current && last?.kind === "bot" && !last.streaming) {
      voiceRef.current.speak(last.content);
    }
  }, [streaming, messages]);

  function openNewRoom() {
    setRoomName("");
    setRoomBotIds(new Set());
    setRoomDialog("new");
  }

  function openEditRoom(r: Room) {
    setRoomName(r.name);
    setRoomBotIds(new Set(r.bots.map((b) => b.id)));
    setRoomDialog(r);
  }

  async function saveRoom() {
    if (!roomName.trim() || !roomDialog) return;
    if (roomDialog === "new") {
      const res = await fetch("/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: roomName, botIds: [...roomBotIds] }),
      });
      if (!res.ok) return;
    } else {
      const res = await fetch(`/api/rooms/${roomDialog.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: roomName,
          botIds: [...roomBotIds],
        }),
      });
      if (!res.ok) return;
    }
    setRoomDialog(null);
    setRoomName("");
    setRoomBotIds(new Set());
    await loadRooms();
  }

  async function deleteRoom(id: number) {
    await fetch(`/api/rooms/${id}`, { method: "DELETE" });
    setRooms((rs) => rs.filter((r) => r.id !== id));
    if (activeRoom?.id === id) {
      setActiveRoom(null);
      setMessages([]);
    }
  }

  async function send(text: string, room = activeRoom) {
    if (streaming || !text.trim() || !room) return;
    setStreaming(true);
    abortRef.current = new AbortController();

    try {
      const res = await fetch(`/api/rooms/${room.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: text }),
        signal: abortRef.current.signal,
      });
      if (!res.ok || !res.body) throw new Error("Request failed");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let e: any;
          try {
            e = JSON.parse(line);
          } catch {
            continue;
          }
          if (e.type === "message") {
            const m = e.message;
            const bot = room.bots.find((b) => b.id === m.sender_id);
            setMessages((ms) => {
              // Replace the streaming placeholder if the last msg matches
              const last = ms[ms.length - 1];
              if (m.kind === "bot" && last?.streaming && last.sender_id === m.sender_id) {
                return [
                  ...ms.slice(0, -1),
                  { ...m, avatar: last.avatar ?? bot?.avatar },
                ];
              }
              return [...ms, { ...m, avatar: bot?.avatar }];
            });
          } else if (e.type === "bot_start") {
            setMessages((ms) => [
              ...ms,
              {
                kind: "bot",
                sender_id: e.bot.id,
                sender_name: e.bot.name,
                avatar: e.bot.avatar,
                content: "",
                streaming: true,
              },
            ]);
          } else if (e.type === "bot_silent") {
            setMessages((ms) => {
              const last = ms[ms.length - 1];
              if (last?.streaming && last.sender_id === e.botId) {
                return ms.slice(0, -1);
              }
              return ms;
            });
          } else if (e.type === "delta") {
            setMessages((ms) => {
              const copy = [...ms];
              const last = copy[copy.length - 1];
              if (last?.kind === "bot" && last.sender_id === e.botId) {
                copy[copy.length - 1] = {
                  ...last,
                  content: last.content + e.text,
                };
              }
              return copy;
            });
          }
        }
      }
    } catch {
      // aborted or network error
    } finally {
      setStreaming(false);
      setMessages((ms) => ms.map((m) => ({ ...m, streaming: false })));
      loadRooms();
    }
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  async function openBotDialog(b: Bot) {
    const res = await fetch(`/api/bots/${b.id}`);
    if (res.ok) setBotDialog((await res.json()).bot);
  }

  async function openDirectChat(bot: Bot): Promise<Room | null> {
    const existing = rooms.find((r) => r.direct_bot_id === bot.id);
    if (existing) {
      openRoom(existing);
      return existing;
    }
    const res = await fetch("/api/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: bot.name,
        botIds: [bot.id],
        directBotId: bot.id,
      }),
    });
    if (res.ok) {
      const { room } = await res.json();
      await loadRooms();
      const full: Room = { ...room, direct_bot_id: bot.id, bots: [bot] };
      openRoom(full);
      return full;
    }
    return null;
  }

  return (
    <div className="flex h-screen overflow-hidden wco-inset">
      <div className="titlebar-drag">
        {isDesktop && (
          <div className="no-drag absolute right-0 top-0 flex h-full items-stretch">
            <button
              onClick={() => (window as any).itaskDesktop.minimize()}
              className="w-11 flex items-center justify-center text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-700"
              aria-label="Minimize"
            >
              <Minus size={15} />
            </button>
            <button
              onClick={() => (window as any).itaskDesktop.toggleMaximize()}
              className="w-11 flex items-center justify-center text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-700"
              aria-label="Maximize"
            >
              <Square size={13} />
            </button>
            <button
              onClick={() => (window as any).itaskDesktop.close()}
              className="w-11 flex items-center justify-center text-zinc-500 hover:bg-red-500 hover:text-white"
              aria-label="Close"
            >
              <X size={15} />
            </button>
          </div>
        )}
      </div>
      <aside
        className={`${
          activeRoom ? "hidden md:flex" : "flex"
        } w-full md:w-64 shrink-0 flex-col border-r border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/50`}
      >
          {/* Bots */}
          <div className="p-3 pb-1 flex items-center justify-between">
            <p className="text-xs font-semibold uppercase text-zinc-500">
              {t("bots")}
            </p>
            <button
              onClick={() => setBotDialog("new")}
              className="text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
              title={t("addBot")}
            >
              +
            </button>
          </div>
          <div className="px-3 space-y-0.5 max-h-48 overflow-y-auto">
            {bots.length === 0 && (
              <p className="px-1 py-2 text-xs text-zinc-500">{t("noBots")}</p>
            )}
            {bots.map((b) => (
              <div
                key={b.id}
                onClick={() => openDirectChat(b)}
                title={`Chat với ${b.name}`}
                className={`group flex items-center gap-2.5 rounded-lg px-2 py-2 cursor-pointer ${
                  activeRoom?.direct_bot_id === b.id
                    ? "bg-zinc-200 dark:bg-zinc-800"
                    : "hover:bg-zinc-100 dark:hover:bg-zinc-900"
                }`}
              >
                <BotAvatar avatar={b.avatar} botId={b.id} size={28} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate flex items-center gap-1.5">
                    {b.name}
                    {b.thinking && (
                      <span className="typing-dots text-emerald-500 scale-75 origin-left shrink-0">
                        <span />
                        <span />
                        <span />
                      </span>
                    )}
                  </p>
                  {b.role && (
                    <p className="text-xs text-zinc-500 truncate">{b.role}</p>
                  )}
                </div>
                <button
                  title={t("editBot")}
                  onClick={(e) => {
                    e.stopPropagation();
                    openBotDialog(b);
                  }}
                  className="opacity-0 group-hover:opacity-100 text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 px-1 text-xs"
                >
                  ✎
                </button>
              </div>
            ))}
          </div>

          {/* Rooms */}
          <div className="p-3 pb-1 mt-2 flex items-center justify-between">
            <p className="text-xs font-semibold uppercase text-zinc-500">
              {t("rooms")}
            </p>
            <button
              onClick={openNewRoom}
              className="text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
              title={t("newRoom")}
            >
              +
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-0.5">
            {rooms.filter((r) => !r.direct_bot_id && r.kind !== "bot_dm")
              .length === 0 && (
              <p className="px-1 py-2 text-xs text-zinc-500">{t("noRooms")}</p>
            )}
            {rooms
              .filter((r) => !r.direct_bot_id && r.kind !== "bot_dm")
              .map((r) => {
              const roomBusy = r.bots.some((rb) =>
                bots.find((b) => b.id === rb.id)?.thinking
              );
              return (
              <div
                key={r.id}
                onClick={() => openRoom(r)}
                className={`group flex items-center gap-2 rounded-lg px-2 py-2 cursor-pointer ${
                  activeRoom?.id === r.id
                    ? "bg-zinc-200 dark:bg-zinc-800"
                    : "hover:bg-zinc-100 dark:hover:bg-zinc-900"
                }`}
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm truncate flex items-center gap-1.5">
                    {r.name}
                    {roomBusy && (
                      <span className="typing-dots text-emerald-500 scale-75 origin-left shrink-0">
                        <span />
                        <span />
                        <span />
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-zinc-500 truncate">
                    {r.bots.map((b) => b.name).join(", ")}
                  </p>
                </div>
                <button
                  title={t("editRoom")}
                  onClick={(e) => {
                    e.stopPropagation();
                    openEditRoom(r);
                  }}
                  className="opacity-0 group-hover:opacity-100 text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 px-1 text-xs"
                >
                  ✎
                </button>
                <button
                  title={t("delete")}
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteRoom(r.id);
                  }}
                  className="opacity-0 group-hover:opacity-100 text-zinc-400 hover:text-red-500 px-1"
                >
                  ✕
                </button>
              </div>
              );
            })}

            {/* Bot↔bot channels — watch colleagues coordinate */}
            {rooms.some((r) => r.kind === "bot_dm") && (
              <>
                <p className="px-1 pt-4 pb-1 text-xs font-semibold uppercase text-zinc-500">
                  {t("botChats")}
                </p>
                {rooms
                  .filter((r) => r.kind === "bot_dm")
                  .map((r) => {
                    const roomBusy = r.bots.some((rb) =>
                      bots.find((b) => b.id === rb.id)?.thinking
                    );
                    return (
                      <div
                        key={r.id}
                        onClick={() => openRoom(r)}
                        className={`group flex items-center gap-2 rounded-lg px-2 py-2 cursor-pointer ${
                          activeRoom?.id === r.id
                            ? "bg-zinc-200 dark:bg-zinc-800"
                            : "hover:bg-zinc-100 dark:hover:bg-zinc-900"
                        }`}
                      >
                        <div className="min-w-0 flex-1">
                          <p className="text-sm truncate flex items-center gap-1.5">
                            {r.name}
                            {roomBusy && (
                              <span className="typing-dots text-emerald-500 scale-75 origin-left shrink-0">
                                <span />
                                <span />
                                <span />
                              </span>
                            )}
                          </p>
                        </div>
                        <button
                          title={t("delete")}
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteRoom(r.id);
                          }}
                          className="opacity-0 group-hover:opacity-100 text-zinc-400 hover:text-red-500 px-1"
                        >
                          ✕
                        </button>
                      </div>
                    );
                  })}
              </>
            )}
          </div>

          <div className="relative border-t border-zinc-200 dark:border-zinc-800 p-3">
            {userMenuOpen && (
              <>
                <div
                  className="fixed inset-0 z-40"
                  onClick={() => setUserMenuOpen(false)}
                />
                <div className="absolute bottom-full left-3 right-3 mb-2 z-50 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-xl overflow-hidden py-1">
                  <button
                    onClick={() => {
                      setUserMenuOpen(false);
                      setSettingsOpen(true);
                    }}
                    className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm text-left hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
                    {t("settings")}
                  </button>
                  <button
                    onClick={() => {
                      setUserMenuOpen(false);
                      setBotDialog("new");
                    }}
                    className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm text-left hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                    {t("addBot")}
                  </button>
                  <button
                    onClick={toggleTheme}
                    className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm text-left hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  >
                    {dark ? (
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
                    ) : (
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/></svg>
                    )}
                    {dark ? "Chế độ sáng" : "Chế độ tối"}
                  </button>
                  <button
                    onClick={() => setLang(lang === "vi" ? "en" : "vi")}
                    className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm text-left hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
                    {lang === "vi" ? "English" : "Tiếng Việt"}
                  </button>
                  <div className="h-px bg-zinc-200 dark:bg-zinc-800 my-1" />
                  <button
                    onClick={logout}
                    className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm text-left text-red-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
                    {t("logout")}
                  </button>
                </div>
              </>
            )}
            <button
              onClick={() => setUserMenuOpen((o) => !o)}
              className="w-full flex items-center gap-2 rounded-lg px-1 py-1 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-left"
            >
              <div className="w-8 h-8 rounded-full bg-zinc-300 dark:bg-zinc-700 flex items-center justify-center text-sm font-semibold shrink-0">
                {user.name.charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{user.name}</p>
                <p className="truncate text-xs text-zinc-500">{user.email}</p>
              </div>
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                className="text-zinc-400 shrink-0"
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
          </div>
        </aside>

      <main
        className={`${
          activeRoom ? "flex" : "hidden md:flex"
        } relative flex-1 flex-col min-w-0`}
      >
        {!activeRoom ? (
          <div className="flex-1 flex flex-col items-center justify-center px-4 gap-6">
            <div className="text-center space-y-2">
              <h1 className="text-2xl font-semibold">{t("appName")}</h1>
              <p className="text-zinc-500">
                {bots.length === 0 ? t("noBots") : t("emptyTitle")}
              </p>
            </div>
            {bots.length === 0 ? (
              <button
                onClick={() => setBotDialog("new")}
                className="rounded-lg bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 px-4 py-2 text-sm font-medium"
              >
                + {t("addBot")}
              </button>
            ) : (
              <div className="w-full max-w-2xl space-y-3">
                <div className="flex flex-wrap justify-center gap-2">
                  {bots.map((b) => (
                    <button
                      key={b.id}
                      onClick={() => setDirectBotId(b.id)}
                      className={`flex items-center gap-2 rounded-full px-3.5 py-1.5 text-sm border transition-colors ${
                        directBotId === b.id
                          ? "border-zinc-900 dark:border-zinc-100 bg-zinc-100 dark:bg-zinc-800 font-medium"
                          : "border-zinc-300 dark:border-zinc-700 text-zinc-500 hover:border-zinc-400"
                      }`}
                    >
                      <BotAvatar avatar={b.avatar} botId={b.id} size={20} />
                      {b.name}
                    </button>
                  ))}
                </div>
                <Composer
                  onSend={async (text) => {
                    const bot =
                      bots.find((b) => b.id === directBotId) ?? bots[0];
                    const room = await openDirectChat(bot);
                    if (room) send(text, room);
                  }}
                  disabled={streaming}
                  large
                  placeholder={t("typeMessage")}
                />
              </div>
            )}
          </div>
        ) : (
          <>
            <div className="absolute top-3 inset-x-0 flex justify-center pointer-events-none z-10 px-3">
              <div className="flex items-center gap-2.5 pl-1.5 pr-4 py-1.5 rounded-full bg-zinc-100/90 dark:bg-zinc-800/80 border border-zinc-200/60 dark:border-zinc-700/60 shadow-sm backdrop-blur-sm pointer-events-auto">
                <button
                  onClick={() => setActiveRoom(null)}
                  className="md:hidden -ml-0.5 w-7 h-7 flex items-center justify-center rounded-full text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-700"
                  aria-label="Back"
                >
                  <ChevronLeft size={18} />
                </button>
                <div className="flex -space-x-1.5">
                  {activeRoom.bots.map((b) => (
                    <BotAvatar
                      key={b.id}
                      avatar={b.avatar}
                      botId={b.id}
                      size={32}
                      className="ring-2 ring-zinc-100 dark:ring-zinc-800"
                      title={b.name}
                    />
                  ))}
                </div>
                <span className="font-semibold text-sm">
                  {activeRoom.name}
                </span>
              </div>
            </div>
            {messages.length === 0 && !roomThinking ? (
              <div className="flex-1 flex items-center justify-center text-zinc-500 text-sm px-4 text-center">
                {t("roomEmpty")}
              </div>
            ) : (
              <RoomMessageList
                messages={messages}
                streaming={streaming || roomThinking}
                thinkingBot={
                  roomThinking && !streaming
                    ? activeRoom?.bots.find((rb) =>
                        bots.find((b) => b.id === rb.id)?.thinking
                      )
                    : undefined
                }
                onSuggestion={(text) => send(text)}
              />
            )}
            <div className="px-4 pb-4">
              <Composer
                onSend={send}
                disabled={streaming}
                placeholder={`${t("messageTo")} ${activeRoom.name}`}
                voiceStatus={voiceStatus}
                voiceInterim={voiceInterim}
                onToggleVoice={toggleVoice}
              />
            </div>
          </>
        )}
      </main>

      {/* New room dialog */}
      {roomDialog && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setRoomDialog(null)}
        >
          <div
            className="w-full max-w-sm rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-5 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="font-semibold">
              {roomDialog === "new" ? t("newRoom") : t("editRoom")}
            </h2>
            <input
              autoFocus
              placeholder={t("roomName")}
              value={roomName}
              onChange={(e) => setRoomName(e.target.value)}
              className="w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-zinc-500"
            />
            <div>
              <p className="text-xs font-medium text-zinc-500 mb-2">
                {t("selectBots")}
              </p>
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {bots.map((b) => (
                  <label
                    key={b.id}
                    className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={roomBotIds.has(b.id)}
                      onChange={(e) => {
                        const next = new Set(roomBotIds);
                        if (e.target.checked) next.add(b.id);
                        else next.delete(b.id);
                        setRoomBotIds(next);
                      }}
                      className="w-4 h-4 accent-zinc-700"
                    />
                    <BotAvatar avatar={b.avatar} botId={b.id} size={24} />
                    <span className="text-sm">{b.name}</span>
                  </label>
                ))}
                {bots.length === 0 && (
                  <p className="text-xs text-zinc-500">{t("noBots")}</p>
                )}
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setRoomDialog(null)}
                className="rounded-lg px-4 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
              >
                {t("cancel")}
              </button>
              <button
                onClick={saveRoom}
                disabled={!roomName.trim()}
                className="rounded-lg bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 px-4 py-2 text-sm font-medium disabled:opacity-50"
              >
                {roomDialog === "new" ? t("create") : t("save")}
              </button>
            </div>
          </div>
        </div>
      )}

      {botDialog !== null && (
        <BotDialog
          bot={botDialog === "new" ? null : botDialog}
          onClose={() => setBotDialog(null)}
          onSaved={loadBots}
        />
      )}

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
}
