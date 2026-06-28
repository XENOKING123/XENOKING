import { useCallback, useEffect, useRef, useState } from "react";
import { MessageCircle, Send, Smile, Image as GifIcon, X, Users, Wifi, WifiOff, VolumeX } from "lucide-react";

// ─── Config ───────────────────────────────────────────────────────────────

// After deploying chat-worker/ to Cloudflare, replace with your Worker URL:
//   wrangler deploy  →  copy the URL printed  →  set VITE_CHAT_WS_URL in GitHub Secrets
const CHAT_WS_URL: string = (import.meta as any).env?.VITE_CHAT_WS_URL ?? "";

const TENOR_KEY = "LIVDSRZULELA"; // Tenor public demo key

// ─── Types ────────────────────────────────────────────────────────────────

type MsgType = "msg" | "gif" | "join" | "leave" | "history" | "online" | "muted";
interface ChatMsg {
  type: MsgType;
  id?: string;
  nick?: string;
  color?: string;
  text?: string;
  url?: string;
  ts?: number;
  msgs?: ChatMsg[];
  count?: number;
}

const COLOR_OPTIONS = [
  { hex: "#f5c518", label: "Gold" },
  { hex: "#ef4444", label: "Red" },
  { hex: "#22c55e", label: "Green" },
  { hex: "#3b82f6", label: "Blue" },
  { hex: "#a855f7", label: "Purple" },
  { hex: "#ec4899", label: "Pink" },
  { hex: "#f97316", label: "Orange" },
  { hex: "#06b6d4", label: "Cyan" },
];

const EMOJIS = [
  "😂","😭","💀","🔥","🤣","😍","🥹","😎","🤯","💪",
  "👀","🙏","✅","❌","🎮","👾","🕹️","⚡","💥","🏆",
  "🐐","🤝","💯","😤","🥶","😈","👑","🎯","🔑","💎",
  "🦔","⚙️","🛡️","🗡️","🌟","💫","🎉","🚀","😴","🤔",
];

// ─── Local storage helpers ─────────────────────────────────────────────────

const LS_NICK    = "xeno.chat.nick";
const LS_COLOR   = "xeno.chat.color";
const LS_MUTED   = "xeno.chat.muted";

function getSaved(key: string, fallback: string) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function setSaved(key: string, val: string) {
  try { localStorage.setItem(key, val); } catch {}
}
function getMuted(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(LS_MUTED) ?? "[]")); } catch { return new Set(); }
}
function addMuted(nick: string) {
  const s = getMuted(); s.add(nick.toLowerCase());
  try { localStorage.setItem(LS_MUTED, JSON.stringify([...s])); } catch {}
}

// ─── Link / GIF detection ─────────────────────────────────────────────────

const GIF_DOMAINS = ["media.tenor.com", "tenor.com", "media.giphy.com", "giphy.com", "i.imgur.com", "cdn.discordapp.com"];

function isGifUrl(url: string) {
  try {
    const u = new URL(url);
    return GIF_DOMAINS.some((d) => u.hostname.endsWith(d)) || u.pathname.endsWith(".gif") || u.pathname.endsWith(".webp");
  } catch { return false; }
}

function isUrl(s: string) {
  return /^https?:\/\/\S+/.test(s);
}

// ─── Message bubble ───────────────────────────────────────────────────────

function MsgBubble({
  msg, isAdmin, onMute,
}: {
  msg: ChatMsg;
  isAdmin: boolean;
  onMute: (nick: string) => void;
}) {
  const isSystem = msg.nick === "SYSTEM";

  if (msg.type === "join" || msg.type === "leave") {
    return (
      <div className="flex justify-center py-1">
        <span className="text-[11px] text-[var(--color-muted)] bg-[var(--color-surface-3)] px-2 py-0.5 rounded-full">
          <span style={{ color: msg.color }}>{msg.nick}</span>
          {msg.type === "join" ? " joined the chat" : " left"}
        </span>
      </div>
    );
  }

  const time = msg.ts
    ? new Date(msg.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "";

  return (
    <div className="group flex items-start gap-2 px-3 py-1.5 hover:bg-[var(--color-surface-3)] rounded-lg transition-colors">
      {/* Avatar dot */}
      <div
        className="mt-1 h-7 w-7 shrink-0 rounded-full border-2 flex items-center justify-center text-xs font-bold text-black"
        style={{ background: msg.color ?? "#888", borderColor: msg.color ?? "#888" }}
      >
        {(msg.nick ?? "?")[0].toUpperCase()}
      </div>

      <div className="flex-1 min-w-0">
        {/* Header */}
        <div className="flex items-baseline gap-2 mb-0.5">
          <span className="text-sm font-bold truncate" style={{ color: isSystem ? "#ef4444" : (msg.color ?? "var(--color-text)") }}>
            {msg.nick}
          </span>
          <span className="text-[10px] text-[var(--color-muted)] shrink-0">{time}</span>
          {/* Mute button — visible on hover, hidden for own/system msgs */}
          {!isSystem && (
            <button
              type="button"
              onClick={() => onMute(msg.nick!)}
              className="ml-auto opacity-0 group-hover:opacity-100 transition-opacity text-[var(--color-muted)] hover:text-[var(--color-bad)] p-0.5 rounded"
              title={`Mute ${msg.nick}`}
            >
              <VolumeX size={12} />
            </button>
          )}
          {isAdmin && !isSystem && (
            <span className="text-[9px] bg-[var(--color-gold)] text-black font-bold px-1 rounded">ADMIN</span>
          )}
        </div>

        {/* Content */}
        {msg.type === "gif" && msg.url ? (
          <img
            src={msg.url}
            alt="gif"
            className="rounded-lg max-w-[240px] max-h-[180px] object-cover border border-[var(--color-border)]"
            loading="lazy"
          />
        ) : (
          <p className="text-sm text-[var(--color-text)] break-words leading-relaxed whitespace-pre-wrap">
            {renderText(msg.text ?? "")}
          </p>
        )}
      </div>
    </div>
  );
}

function renderText(text: string) {
  const parts = text.split(/(https?:\/\/\S+)/g);
  return parts.map((part, i) =>
    isUrl(part) ? (
      <a
        key={i}
        href={part}
        target="_blank"
        rel="noopener noreferrer"
        className="text-[var(--color-accent)] underline underline-offset-2 hover:opacity-80 break-all"
      >
        {part}
      </a>
    ) : (
      <span key={i}>{part}</span>
    )
  );
}

// ─── GIF Picker ───────────────────────────────────────────────────────────

function GifPickerPanel({ onSelect, onClose }: { onSelect: (url: string) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<{ url: string; preview: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function search(query: string) {
    if (!query.trim()) { setResults([]); return; }
    setBusy(true);
    try {
      const url = `https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(query)}&key=${TENOR_KEY}&limit=20&media_filter=gif`;
      const res = await fetch(url);
      const data = await res.json();
      setResults(
        (data.results ?? []).map((r: any) => ({
          url: r.media_formats?.gif?.url ?? "",
          preview: r.media_formats?.tinygif?.url ?? r.media_formats?.gif?.url ?? "",
        })).filter((r: any) => r.url)
      );
    } catch { setResults([]); }
    finally { setBusy(false); }
  }

  function handleChange(v: string) {
    setQ(v);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => search(v), 500);
  }

  return (
    <div className="absolute bottom-full mb-2 left-0 w-72 bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-xl shadow-2xl overflow-hidden z-50">
      <div className="flex items-center gap-2 p-2 border-b border-[var(--color-border)]">
        <input
          autoFocus
          value={q}
          onChange={(e) => handleChange(e.target.value)}
          placeholder="Search GIFs..."
          className="flex-1 bg-transparent text-sm text-[var(--color-text)] placeholder-[var(--color-muted)] outline-none"
        />
        <button type="button" onClick={onClose} className="text-[var(--color-muted)] hover:text-[var(--color-text)]">
          <X size={14} />
        </button>
      </div>
      <div className="grid grid-cols-3 gap-1 p-2 max-h-52 overflow-y-auto">
        {busy && <div className="col-span-3 text-center text-xs text-[var(--color-muted)] py-4">Searching…</div>}
        {!busy && results.length === 0 && q && (
          <div className="col-span-3 text-center text-xs text-[var(--color-muted)] py-4">No results</div>
        )}
        {!busy && results.length === 0 && !q && (
          <div className="col-span-3 text-center text-xs text-[var(--color-muted)] py-4">Type to search GIFs</div>
        )}
        {results.map((r, i) => (
          <button
            key={i}
            type="button"
            onClick={() => { onSelect(r.url); onClose(); }}
            className="aspect-square overflow-hidden rounded bg-[var(--color-surface-3)] hover:opacity-80 transition-opacity"
          >
            <img src={r.preview} alt="" className="w-full h-full object-cover" loading="lazy" />
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Join Modal ───────────────────────────────────────────────────────────

function JoinModal({ onJoin }: { onJoin: (nick: string, color: string) => void }) {
  const [nick, setNick] = useState(getSaved(LS_NICK, ""));
  const [color, setColor] = useState(getSaved(LS_COLOR, COLOR_OPTIONS[0].hex));
  const [err, setErr] = useState("");

  function submit() {
    const n = nick.trim().slice(0, 24);
    if (n.length < 2) { setErr("Name must be at least 2 characters"); return; }
    if (!/^[\w\s.\-!]+$/.test(n)) { setErr("Letters, numbers, spaces, . - ! only"); return; }
    setSaved(LS_NICK, n);
    setSaved(LS_COLOR, color);
    onJoin(n, color);
  }

  return (
    <div className="flex h-full flex-col items-center justify-center p-8">
      <div className="w-full max-w-sm bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-2xl p-6 shadow-2xl">
        {/* Icon */}
        <div className="flex justify-center mb-5">
          <div className="h-14 w-14 rounded-full bg-[var(--color-gold-soft)] flex items-center justify-center">
            <MessageCircle size={28} className="text-[var(--color-gold)]" />
          </div>
        </div>

        <h2 className="text-center text-xl font-extrabold text-[var(--color-text)] mb-1">
          Join XENO Chat
        </h2>
        <p className="text-center text-xs text-[var(--color-muted)] mb-6">
          Community chat — share cheats, ask questions, vibe
        </p>

        {/* Name */}
        <label className="block text-xs font-semibold text-[var(--color-muted)] uppercase tracking-wider mb-1.5">
          Your name
        </label>
        <input
          autoFocus
          value={nick}
          onChange={(e) => { setNick(e.target.value); setErr(""); }}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          maxLength={24}
          placeholder="e.g. xXxGamer420"
          className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-3)] px-3 py-2 text-sm text-[var(--color-text)] placeholder-[var(--color-muted)] outline-none focus:border-[var(--color-gold)] transition-colors mb-4"
        />

        {/* Color */}
        <label className="block text-xs font-semibold text-[var(--color-muted)] uppercase tracking-wider mb-2">
          Name color
        </label>
        <div className="flex gap-2 mb-5 flex-wrap">
          {COLOR_OPTIONS.map((c) => (
            <button
              key={c.hex}
              type="button"
              onClick={() => setColor(c.hex)}
              title={c.label}
              className="h-7 w-7 rounded-full border-2 transition-transform hover:scale-110"
              style={{
                background: c.hex,
                borderColor: color === c.hex ? "white" : "transparent",
                boxShadow: color === c.hex ? `0 0 0 2px ${c.hex}` : "none",
              }}
            />
          ))}
        </div>

        {/* Preview */}
        <div className="mb-5 rounded-lg bg-[var(--color-surface-3)] px-3 py-2 text-sm">
          <span className="font-bold" style={{ color }}>
            {nick.trim() || "YourName"}
          </span>
          <span className="text-[var(--color-text)]"> : Hello everyone! 👋</span>
        </div>

        {err && <p className="text-xs text-[var(--color-bad)] mb-3">{err}</p>}

        <button
          type="button"
          onClick={submit}
          className="w-full rounded-lg bg-[var(--color-gold)] py-2.5 text-sm font-bold text-black hover:opacity-90 transition-opacity"
        >
          Jump In
        </button>
      </div>
    </div>
  );
}

// ─── Main Screen ─────────────────────────────────────────────────────────

export default function ChatScreen() {
  const [joined, setJoined] = useState(false);
  const [nick, setNick] = useState("");
  const [color, setColor] = useState(COLOR_OPTIONS[0].hex);
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [online, setOnline] = useState(0);
  const [text, setText] = useState("");
  const [status, setStatus] = useState<"disconnected" | "connecting" | "connected" | "muted">("disconnected");
  const [showEmoji, setShowEmoji] = useState(false);
  const [showGif, setShowGif] = useState(false);
  const [muted, setMuted] = useState<Set<string>>(getMuted);
  const [contextMenu, setContextMenu] = useState<{ nick: string; x: number; y: number } | null>(null);

  const ws = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const isAdmin = nick === "XENOKING" || nick === "xenoking";

  // ── WebSocket connect ─────────────────────────────────────────────────

  const connect = useCallback((n: string, c: string) => {
    if (!CHAT_WS_URL || ws.current?.readyState === WebSocket.OPEN) return;
    setStatus("connecting");

    const socket = new WebSocket(CHAT_WS_URL);
    ws.current = socket;

    socket.onopen = () => {
      setStatus("connected");
      socket.send(JSON.stringify({ type: "identify", nick: n, color: c }));
    };

    socket.onmessage = (e) => {
      let msg: ChatMsg;
      try { msg = JSON.parse(e.data); } catch { return; }

      if (msg.type === "muted") { setStatus("muted"); socket.close(); return; }
      if (msg.type === "online") { setOnline(msg.count ?? 0); return; }
      if (msg.type === "history") {
        setMsgs(msg.msgs ?? []);
        return;
      }
      setMsgs((prev) => [...prev, msg]);
    };

    socket.onclose = () => {
      setStatus("disconnected");
      ws.current = null;
      // Auto-reconnect after 4 seconds
      reconnectTimer.current = setTimeout(() => {
        if (joined) connect(n, c);
      }, 4_000);
    };

    socket.onerror = () => {
      socket.close();
    };
  }, [joined]);

  // ── Auto-scroll ───────────────────────────────────────────────────────

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [msgs]);

  // ── Cleanup ───────────────────────────────────────────────────────────

  useEffect(() => {
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      ws.current?.close();
    };
  }, []);

  // ── Join handler ─────────────────────────────────────────────────────

  function handleJoin(n: string, c: string) {
    setNick(n);
    setColor(c);
    setJoined(true);
    connect(n, c);
  }

  // ── Send ─────────────────────────────────────────────────────────────

  function sendMsg() {
    const t = text.trim();
    if (!t || status !== "connected" || !ws.current) return;

    // Detect if pasted text is a GIF URL
    if (isGifUrl(t)) {
      ws.current.send(JSON.stringify({ type: "gif", url: t }));
    } else {
      ws.current.send(JSON.stringify({ type: "msg", text: t }));
    }
    setText("");
    inputRef.current?.focus();
  }

  function sendGif(url: string) {
    if (!ws.current || status !== "connected") return;
    ws.current.send(JSON.stringify({ type: "gif", url }));
  }

  function insertEmoji(e: string) {
    setText((t) => t + e);
    setShowEmoji(false);
    inputRef.current?.focus();
  }

  // ── Mute handler ─────────────────────────────────────────────────────

  function muteUser(n: string) {
    if (n === nick) return;
    addMuted(n);
    setMuted(getMuted());
    setContextMenu(null);

    // Admin: also mute server-side
    if (isAdmin && ws.current) {
      ws.current.send(JSON.stringify({ type: "admin_mute", target: n }));
    }
  }

  function handleContextMenu(e: React.MouseEvent, n: string) {
    if (n === nick) return;
    e.preventDefault();
    setContextMenu({ nick: n, x: e.clientX, y: e.clientY });
  }

  // ── No server configured ─────────────────────────────────────────────

  if (!CHAT_WS_URL) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
        <MessageCircle size={48} className="text-[var(--color-muted)]" />
        <h2 className="text-lg font-bold text-[var(--color-text)]">Chat Server Not Configured</h2>
        <p className="text-sm text-[var(--color-muted)] max-w-xs leading-relaxed">
          Deploy the <code className="text-[var(--color-gold)]">chat-worker/</code> to Cloudflare,
          then add <code className="text-[var(--color-gold)]">VITE_CHAT_WS_URL</code> to your GitHub Secrets
          and the chat will be live for all users.
        </p>
        <p className="text-xs text-[var(--color-muted)]">
          One command: <code className="text-[var(--color-accent)]">cd chat-worker && npx wrangler deploy</code>
        </p>
      </div>
    );
  }

  // ── Join modal ────────────────────────────────────────────────────────

  if (!joined) {
    return <JoinModal onJoin={handleJoin} />;
  }

  // ── Muted screen ─────────────────────────────────────────────────────

  if (status === "muted") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <VolumeX size={48} className="text-[var(--color-bad)]" />
        <h2 className="text-lg font-bold text-[var(--color-text)]">You've been muted</h2>
        <p className="text-sm text-[var(--color-muted)]">Contact an admin in Discord to appeal.</p>
      </div>
    );
  }

  // ── Chat UI ───────────────────────────────────────────────────────────

  return (
    <div
      className="flex h-full flex-col"
      onClick={() => setContextMenu(null)}
    >
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-[var(--color-border)] px-4 py-3 shrink-0">
        <MessageCircle size={18} className="text-[var(--color-gold)]" />
        <span className="font-bold text-[var(--color-text)]">XENO Chat</span>
        <div className="flex items-center gap-1.5 ml-auto text-xs text-[var(--color-muted)]">
          {status === "connected" ? (
            <Wifi size={13} className="text-[var(--color-good)]" />
          ) : (
            <WifiOff size={13} className="text-[var(--color-bad)]" />
          )}
          {status === "connected" ? (
            <>
              <Users size={12} />
              <span>{online} online</span>
            </>
          ) : status === "connecting" ? (
            <span className="animate-pulse">Connecting…</span>
          ) : (
            <span className="text-[var(--color-bad)]">Reconnecting…</span>
          )}
        </div>
        <div
          className="h-6 w-6 rounded-full border-2 text-[9px] font-bold flex items-center justify-center text-black ml-2"
          style={{ background: color, borderColor: color }}
          title={`You: ${nick}`}
        >
          {nick[0].toUpperCase()}
        </div>
      </div>

      {/* Messages */}
      <div ref={listRef} className="flex-1 overflow-y-auto py-2">
        {msgs.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-[var(--color-muted)]">
            <MessageCircle size={32} className="opacity-30" />
            <p className="text-sm">Be the first to say something!</p>
          </div>
        )}
        {msgs.map((msg, i) => {
          // Filter muted users
          if (msg.nick && muted.has(msg.nick.toLowerCase())) {
            return (
              <div key={i} className="px-3 py-1">
                <span className="text-[10px] italic text-[var(--color-muted)]">
                  [message from muted user]
                </span>
              </div>
            );
          }
          return (
            <div
              key={msg.id ?? i}
              onContextMenu={(e) => msg.nick && muteUser !== undefined && handleContextMenu(e, msg.nick)}
            >
              <MsgBubble
                msg={msg}
                isAdmin={isAdmin && msg.nick === "XENOKING"}
                onMute={muteUser}
              />
            </div>
          );
        })}
      </div>

      {/* Input area */}
      <div className="border-t border-[var(--color-border)] px-3 py-2.5 shrink-0">
        <div className="flex items-end gap-2 relative">
          {/* Emoji picker */}
          {showEmoji && (
            <div className="absolute bottom-full mb-2 left-0 bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-xl p-2 shadow-2xl grid grid-cols-8 gap-1 w-64 z-50">
              {EMOJIS.map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => insertEmoji(e)}
                  className="text-lg rounded hover:bg-[var(--color-surface-3)] p-0.5 transition-colors leading-none"
                >
                  {e}
                </button>
              ))}
            </div>
          )}

          {/* GIF picker */}
          {showGif && (
            <GifPickerPanel
              onSelect={sendGif}
              onClose={() => setShowGif(false)}
            />
          )}

          {/* Emoji button */}
          <button
            type="button"
            onClick={() => { setShowEmoji((v) => !v); setShowGif(false); }}
            className="shrink-0 rounded-lg p-2 text-[var(--color-muted)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text)] transition-colors"
            title="Emoji"
          >
            <Smile size={18} />
          </button>

          {/* GIF button */}
          <button
            type="button"
            onClick={() => { setShowGif((v) => !v); setShowEmoji(false); }}
            className="shrink-0 rounded-lg p-2 text-[var(--color-muted)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text)] transition-colors"
            title="GIF"
          >
            <GifIcon size={18} />
          </button>

          {/* Text input */}
          <textarea
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendMsg();
              }
            }}
            placeholder={status === "connected" ? "Type a message… (paste a GIF link too!)" : "Connecting…"}
            disabled={status !== "connected"}
            rows={1}
            className="flex-1 resize-none rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-3)] px-3 py-2 text-sm text-[var(--color-text)] placeholder-[var(--color-muted)] outline-none focus:border-[var(--color-gold)] transition-colors disabled:opacity-50 max-h-24 leading-relaxed"
            style={{ scrollbarWidth: "none" }}
          />

          {/* Send button */}
          <button
            type="button"
            onClick={sendMsg}
            disabled={!text.trim() || status !== "connected"}
            className="shrink-0 rounded-lg bg-[var(--color-gold)] p-2 text-black hover:opacity-90 transition-opacity disabled:opacity-30"
            title="Send (Enter)"
          >
            <Send size={16} />
          </button>
        </div>
      </div>

      {/* Context menu (right-click mute) */}
      {contextMenu && (
        <div
          className="fixed bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-lg shadow-2xl py-1 z-50 min-w-32"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            type="button"
            onClick={() => muteUser(contextMenu.nick)}
            className="flex w-full items-center gap-2 px-3 py-2 text-sm text-[var(--color-text)] hover:bg-[var(--color-surface-3)] transition-colors"
          >
            <VolumeX size={14} className="text-[var(--color-bad)]" />
            Mute {contextMenu.nick}
          </button>
          {isAdmin && (
            <button
              type="button"
              onClick={() => {
                ws.current?.send(JSON.stringify({ type: "admin_mute", target: contextMenu.nick }));
                setContextMenu(null);
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-[var(--color-bad)] hover:bg-[var(--color-surface-3)] transition-colors"
            >
              🔨 Ban {contextMenu.nick} (server)
            </button>
          )}
        </div>
      )}
    </div>
  );
}
