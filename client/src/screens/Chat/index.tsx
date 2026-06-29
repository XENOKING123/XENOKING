import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Send, X, Users, Settings, Pin, Trash2, Ban, Crown, AtSign, ImagePlus, ChevronDown, LogOut, Check } from "lucide-react";

// ─── Config ───────────────────────────────────────────────────────────────────
const API = "https://xeno-chat.alexhaha417.workers.dev";
const WS_URL = "wss://xeno-chat.alexhaha417.workers.dev";
const TENOR_KEY = "LIVDSRZULELA";
const TOKEN_KEY = "xeno.chat.token";

// ─── Types ────────────────────────────────────────────────────────────────────
interface Profile { username: string; displayName: string; color: string; bio: string; avatarUrl: string; bannerColor: string; isOwner: boolean; joinedAt: number; }
interface Msg { type: "msg"|"gif"|"image"|"system"; id: string; username: string; displayName: string; color: string; avatarUrl: string; text?: string; url?: string; ts: number; mentions: string[]; }
interface PinMsg { id: string; username: string; displayName: string; color: string; text: string; ts: number; pinnedBy: string; }
interface OnlineUser { username: string; displayName: string; color: string; avatarUrl: string; isOwner: boolean; }
interface GifResult { id: string; preview: string; url: string; }
interface CtxMenu { x: number; y: number; msg: Msg; }

// ─── Helpers ──────────────────────────────────────────────────────────────────
function playMentionSound() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.setValueAtTime(1047, ctx.currentTime);
    osc.frequency.setValueAtTime(1319, ctx.currentTime + 0.08);
    gain.gain.setValueAtTime(0.18, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.45);
    osc.start(); osc.stop(ctx.currentTime + 0.45);
    setTimeout(() => ctx.close(), 600);
  } catch {}
}

function fmtTime(ts: number) { return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
function fmtDate(ts: number) { return new Date(ts).toLocaleDateString([], { year: "numeric", month: "long", day: "numeric" }); }
function initials(n: string) { return (n || "?")[0].toUpperCase(); }

// ─── Avatar ───────────────────────────────────────────────────────────────────
function Avatar({ p, size = 36, onClick }: { p: { displayName: string; color: string; avatarUrl: string }; size?: number; onClick?: () => void }) {
  if (p.avatarUrl) {
    return <img src={p.avatarUrl} alt="" onClick={onClick} style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover", flexShrink: 0, cursor: onClick ? "pointer" : "default", border: `2px solid ${p.color}40` }} onError={e => { (e.target as HTMLImageElement).style.display = "none"; }} />;
  }
  return (
    <div onClick={onClick} style={{ width: size, height: size, borderRadius: "50%", background: p.color + "22", border: `2px solid ${p.color}60`, color: p.color, fontSize: size * 0.42, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, cursor: onClick ? "pointer" : "default", userSelect: "none" }}>
      {initials(p.displayName)}
    </div>
  );
}

// ─── Profile Modal ────────────────────────────────────────────────────────────
function ProfileModal({ profile, myProfile, onClose, onBan }: { profile: Profile; myProfile: Profile; onClose: () => void; onBan: (u: string) => void }) {
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 200, background: "#000a", display: "flex", alignItems: "center", justifyContent: "center" }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ width: 340, background: "#14141e", borderRadius: 16, overflow: "hidden", boxShadow: "0 20px 60px #0009", border: "1px solid #2a2a3a" }}>
        <div style={{ height: 90, background: profile.bannerColor || "#1a1a2e", position: "relative" }}>
          <button onClick={onClose} style={{ position: "absolute", top: 10, right: 10, background: "#0005", border: "none", color: "#fff", borderRadius: 6, padding: "2px 10px", cursor: "pointer", fontSize: 18 }}>×</button>
        </div>
        <div style={{ padding: "0 20px 20px", marginTop: -36 }}>
          <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", marginBottom: 10 }}>
            <div style={{ padding: 3, background: "#14141e", borderRadius: "50%", display: "inline-flex" }}><Avatar p={profile} size={64} /></div>
            {profile.isOwner && <span style={{ background: "#f5c51820", color: "#f5c518", border: "1px solid #f5c51840", borderRadius: 8, padding: "2px 8px", fontSize: 11, fontWeight: 700, display: "flex", alignItems: "center", gap: 4, marginBottom: 4 }}><Crown size={10} /> OWNER</span>}
          </div>
          <div style={{ color: profile.color, fontWeight: 800, fontSize: 18 }}>{profile.displayName}</div>
          <div style={{ color: "#6b6b8a", fontSize: 12, marginTop: 2 }}>@{profile.username}</div>
          {profile.bio && <div style={{ color: "#b0b0c8", fontSize: 13, marginTop: 10, lineHeight: 1.6 }}>{profile.bio}</div>}
          <div style={{ color: "#4a4a6a", fontSize: 11, marginTop: 10 }}>Member since {fmtDate(profile.joinedAt)}</div>
          {myProfile.isOwner && profile.username !== "xenoking" && profile.username !== myProfile.username && (
            <button onClick={() => { onBan(profile.username); onClose(); }} style={{ marginTop: 16, width: "100%", background: "#ef444418", color: "#ef4444", border: "1px solid #ef444430", borderRadius: 8, padding: "8px 0", cursor: "pointer", fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
              <Ban size={13} /> Ban User
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Settings Modal ───────────────────────────────────────────────────────────
function SettingsModal({ profile, token, onClose, onSaved }: { profile: Profile; token: string; onClose: () => void; onSaved: (p: Profile) => void }) {
  const [form, setForm] = useState({ displayName: profile.displayName, color: profile.color, bio: profile.bio, avatarUrl: profile.avatarUrl, bannerColor: profile.bannerColor || "#1a1a2e" });
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [saved, setSaved] = useState(false);

  async function save() {
    setLoading(true); setErr("");
    try {
      const r = await fetch(`${API}/profile`, { method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(form) });
      const d = await r.json();
      if (!r.ok) setErr(d.error || "Save failed");
      else { onSaved(d); setSaved(true); setTimeout(() => setSaved(false), 2000); }
    } catch { setErr("Network error"); }
    setLoading(false);
  }

  const field = (label: string, key: keyof typeof form, type = "text", ph = "") => (
    <div style={{ marginBottom: 14 }}>
      <label style={{ fontSize: 11, fontWeight: 700, color: "#6b6b8a", textTransform: "uppercase", letterSpacing: "0.1em", display: "block", marginBottom: 5 }}>{label}</label>
      {key === "bio"
        ? <textarea value={form[key]} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))} placeholder={ph} rows={3} style={{ width: "100%", background: "#0d0d14", border: "1px solid #2a2a3a", borderRadius: 8, padding: "8px 12px", color: "#e0e0e8", fontSize: 13, resize: "none", outline: "none", boxSizing: "border-box", fontFamily: "inherit" }} />
        : <input type={type} value={form[key]} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))} placeholder={ph} style={{ width: "100%", background: "#0d0d14", border: "1px solid #2a2a3a", borderRadius: 8, padding: "8px 12px", color: "#e0e0e8", fontSize: 13, outline: "none", boxSizing: "border-box" }} />
      }
    </div>
  );

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 200, background: "#000a", display: "flex", alignItems: "center", justifyContent: "center" }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ width: 390, background: "#14141e", borderRadius: 16, boxShadow: "0 20px 60px #0009", border: "1px solid #2a2a3a", maxHeight: "92vh", overflowY: "auto" }}>
        <div style={{ padding: "20px 24px 0", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontWeight: 800, fontSize: 16, color: "#e0e0e8" }}>Edit Profile</span>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#6b6b8a", cursor: "pointer" }}><X size={18} /></button>
        </div>
        <div style={{ padding: "16px 24px 24px" }}>
          {/* Preview card */}
          <div style={{ marginBottom: 20, background: "#0d0d14", borderRadius: 12, overflow: "hidden", border: "1px solid #2a2a3a" }}>
            <div style={{ height: 60, background: form.bannerColor }} />
            <div style={{ padding: "0 14px 14px", marginTop: -22 }}>
              <div style={{ padding: 2, background: "#0d0d14", borderRadius: "50%", display: "inline-flex" }}><Avatar p={{ displayName: form.displayName, color: form.color, avatarUrl: form.avatarUrl }} size={44} /></div>
              <div style={{ color: form.color, fontWeight: 700, fontSize: 14, marginTop: 4 }}>{form.displayName || "Display Name"}</div>
              <div style={{ color: "#4a4a6a", fontSize: 11 }}>@{profile.username}</div>
              {form.bio && <div style={{ color: "#8888a8", fontSize: 12, marginTop: 4 }}>{form.bio}</div>}
            </div>
          </div>
          {field("Display Name", "displayName", "text", "Your display name")}
          {field("Bio", "bio", "text", "Tell people about yourself…")}
          {field("Avatar URL (paste a direct image link)", "avatarUrl", "url", "https://i.imgur.com/…")}
          <div style={{ display: "flex", gap: 14, marginBottom: 14 }}>
            {(["color", "bannerColor"] as const).map(k => (
              <div key={k} style={{ flex: 1 }}>
                <label style={{ fontSize: 11, fontWeight: 700, color: "#6b6b8a", textTransform: "uppercase", letterSpacing: "0.1em", display: "block", marginBottom: 6 }}>{k === "color" ? "Name Color" : "Banner Color"}</label>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <input type="color" value={form[k]} onChange={e => setForm(f => ({ ...f, [k]: e.target.value }))} style={{ width: 34, height: 34, border: "none", borderRadius: 8, cursor: "pointer", background: "none", padding: 0 }} />
                  <input value={form[k]} onChange={e => setForm(f => ({ ...f, [k]: e.target.value }))} style={{ flex: 1, background: "#0d0d14", border: "1px solid #2a2a3a", borderRadius: 8, padding: "6px 8px", color: "#e0e0e8", fontSize: 11, outline: "none" }} />
                </div>
              </div>
            ))}
          </div>
          {err && <div style={{ color: "#ef4444", fontSize: 12, marginBottom: 10 }}>{err}</div>}
          <button onClick={save} disabled={loading} style={{ width: "100%", background: saved ? "#22c55e" : "#f5c518", color: saved ? "#fff" : "#1a1206", border: "none", borderRadius: 10, padding: "11px 0", fontWeight: 800, fontSize: 14, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 7, transition: "background .2s" }}>
            {saved ? <><Check size={15} /> Saved!</> : loading ? "Saving…" : "Save Changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Auth Screen ──────────────────────────────────────────────────────────────
function AuthScreen({ onAuth }: { onAuth: (token: string, profile: Profile) => void }) {
  const [tab, setTab] = useState<"login"|"signup">("login");
  const [form, setForm] = useState({ username: "", password: "", displayName: "", color: "#f5c518" });
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit() {
    setLoading(true); setErr("");
    try {
      const body = tab === "login" ? { username: form.username, password: form.password } : form;
      const r = await fetch(`${API}/${tab === "login" ? "login" : "register"}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await r.json();
      if (!r.ok) setErr(d.error || "Something went wrong");
      else { localStorage.setItem(TOKEN_KEY, d.token); onAuth(d.token, d.profile); }
    } catch { setErr("Cannot reach chat server. Check your connection."); }
    setLoading(false);
  }

  const inp = (key: keyof typeof form, ph: string, type = "text") => (
    <input type={type} placeholder={ph} value={form[key]} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))} onKeyDown={e => e.key === "Enter" && submit()}
      style={{ width: "100%", background: "#0d0d14", border: "1px solid #2a2a3a", borderRadius: 10, padding: "11px 14px", color: "#e0e0e8", fontSize: 14, outline: "none", boxSizing: "border-box", marginBottom: 10, fontFamily: "inherit" }} />
  );

  return (
    <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#0d0d14" }}>
      <div style={{ width: 360, background: "#14141e", borderRadius: 20, boxShadow: "0 24px 80px #0008", border: "1px solid #2a2a3a", overflow: "hidden" }}>
        <div style={{ padding: "30px 28px 0" }}>
          <div style={{ textAlign: "center", marginBottom: 26 }}>
            <div style={{ fontSize: 30, fontWeight: 900, letterSpacing: "0.1em", color: "#f5c518" }}>XENO CHAT</div>
            <div style={{ color: "#6b6b8a", fontSize: 13, marginTop: 4 }}>Community · Real-time · Free</div>
          </div>
          <div style={{ display: "flex", background: "#0d0d14", borderRadius: 10, padding: 3, marginBottom: 22 }}>
            {(["login","signup"] as const).map(t => (
              <button key={t} onClick={() => { setTab(t); setErr(""); }} style={{ flex: 1, padding: "8px 0", border: "none", borderRadius: 8, cursor: "pointer", fontWeight: 700, fontSize: 13, background: tab === t ? "#f5c518" : "transparent", color: tab === t ? "#1a1206" : "#6b6b8a", transition: "all .15s" }}>
                {t === "login" ? "Log In" : "Sign Up"}
              </button>
            ))}
          </div>
          {inp("username", "Username")}
          {inp("password", "Password", "password")}
          {tab === "signup" && <>
            {inp("displayName", "Display name (shown in chat)")}
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
              <span style={{ color: "#6b6b8a", fontSize: 13 }}>Name color</span>
              <input type="color" value={form.color} onChange={e => setForm(f => ({ ...f, color: e.target.value }))} style={{ width: 32, height: 32, border: "none", borderRadius: 6, cursor: "pointer", background: "none", padding: 0 }} />
              <span style={{ color: form.color, fontWeight: 700, fontSize: 13 }}>Preview</span>
            </div>
          </>}
          {err && <div style={{ color: "#ef4444", fontSize: 13, marginBottom: 10 }}>{err}</div>}
        </div>
        <div style={{ padding: "4px 28px 28px" }}>
          <button onClick={submit} disabled={loading} style={{ width: "100%", background: "#f5c518", color: "#1a1206", border: "none", borderRadius: 10, padding: "13px 0", fontWeight: 800, fontSize: 15, cursor: "pointer" }}>
            {loading ? "…" : tab === "login" ? "Log In" : "Create Account"}
          </button>
          <div style={{ color: "#3a3a5a", fontSize: 11, textAlign: "center", marginTop: 14 }}>Sessions last 30 days. XENOKING is the owner.</div>
        </div>
      </div>
    </div>
  );
}

// ─── Main Chat ────────────────────────────────────────────────────────────────
export default function ChatScreen() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY));
  const [myProfile, setMyProfile] = useState<Profile | null>(null);
  const [authReady, setAuthReady] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const myProfileRef = useRef<Profile | null>(null);
  const [wsStatus, setWsStatus] = useState<"connecting"|"connected"|"disconnected">("disconnected");

  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [pins, setPins] = useState<PinMsg[]>([]);
  const [online, setOnline] = useState<OnlineUser[]>([]);

  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const [gifOpen, setGifOpen] = useState(false);
  const [gifQ, setGifQ] = useState("");
  const [gifs, setGifs] = useState<GifResult[]>([]);
  const [gifLoading, setGifLoading] = useState(false);

  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQ, setMentionQ] = useState("");

  const [ctx, setCtx] = useState<CtxMenu | null>(null);
  const [profileModal, setProfileModal] = useState<Profile | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pinsOpen, setPinsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [imgDialogOpen, setImgDialogOpen] = useState(false);
  const [imgUrl, setImgUrl] = useState("");

  // keep ref in sync for use inside WS closure
  useEffect(() => { myProfileRef.current = myProfile; }, [myProfile]);

  // ── WebSocket ─────────────────────────────────────────────────────────────
  const connect = useCallback((tok: string) => {
    if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.close(); }
    setWsStatus("connecting");
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token: tok }));

    ws.onmessage = (e) => {
      let msg: any;
      try { msg = JSON.parse(e.data); } catch { return; }

      if (msg.type === "welcome") return;
      if (msg.type === "need_auth") { ws.send(JSON.stringify({ type: "auth", token: tok })); return; }

      if (msg.type === "authed") {
        setMyProfile(msg.profile);
        setMsgs(msg.history ?? []);
        setPins(msg.pins ?? []);
        setWsStatus("connected");
        setAuthReady(true);
        return;
      }
      if (msg.type === "auth_error") { localStorage.removeItem(TOKEN_KEY); setToken(null); setMyProfile(null); setAuthReady(true); return; }
      if (msg.type === "banned") { localStorage.removeItem(TOKEN_KEY); setToken(null); setMyProfile(null); setAuthReady(true); alert("Your account has been banned."); return; }

      if (msg.type === "msg" || msg.type === "gif" || msg.type === "image" || msg.type === "system") {
        setMsgs(prev => [...prev.slice(-299), msg]);
        const me = myProfileRef.current;
        if (me && msg.mentions?.includes(me.username)) playMentionSound();
        return;
      }
      if (msg.type === "join") { setMsgs(prev => [...prev, { type: "system", id: crypto.randomUUID(), username: "", displayName: "", color: "", avatarUrl: "", text: `→ ${msg.displayName} joined`, ts: msg.ts, mentions: [] }]); return; }
      if (msg.type === "leave") { setMsgs(prev => [...prev, { type: "system", id: crypto.randomUUID(), username: "", displayName: "", color: "", avatarUrl: "", text: `← ${msg.displayName} left`, ts: msg.ts, mentions: [] }]); return; }
      if (msg.type === "online") { setOnline(msg.users ?? []); return; }
      if (msg.type === "pinned") { setPins(prev => [...prev.filter(p => p.id !== msg.pin.id), msg.pin]); return; }
      if (msg.type === "unpinned") { setPins(prev => prev.filter(p => p.id !== msg.msgId)); return; }
      if (msg.type === "deleted") { setMsgs(prev => prev.filter(m => m.id !== msg.msgId)); return; }
    };

    ws.onclose = () => {
      setWsStatus("disconnected");
      reconnRef.current = setTimeout(() => { if (localStorage.getItem(TOKEN_KEY)) connect(tok); }, 4000);
    };
    ws.onerror = () => ws.close();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (token) connect(token);
    else setAuthReady(true);
    return () => {
      if (reconnRef.current) clearTimeout(reconnRef.current);
      if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.close(); }
    };
  }, [token, connect]);

  // auto-scroll
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (atBottom) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs]);

  // GIF search
  useEffect(() => {
    if (!gifOpen || !gifQ.trim()) { setGifs([]); return; }
    const t = setTimeout(async () => {
      setGifLoading(true);
      try {
        const r = await fetch(`https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(gifQ)}&key=${TENOR_KEY}&limit=15&media_filter=gif,tinygif`);
        const d = await r.json();
        setGifs((d.results ?? []).map((g: any) => ({
          id: g.id,
          preview: g.media_formats?.tinygif?.url || g.media_formats?.gif?.url || "",
          url: g.media_formats?.gif?.url || g.media_formats?.tinygif?.url || "",
        })).filter((g: GifResult) => g.url));
      } catch { setGifs([]); }
      setGifLoading(false);
    }, 400);
    return () => clearTimeout(t);
  }, [gifQ, gifOpen]);

  // close panels on outside click
  useEffect(() => {
    if (!ctx) return;
    const h = () => setCtx(null);
    window.addEventListener("click", h);
    return () => window.removeEventListener("click", h);
  }, [ctx]);

  // ── Actions ────────────────────────────────────────────────────────────────
  function wsSend(data: object) { wsRef.current?.readyState === WebSocket.OPEN && wsRef.current.send(JSON.stringify(data)); }
  function sendMsg() { const t = input.trim(); if (!t) return; wsSend({ type: "msg", text: t }); setInput(""); setMentionOpen(false); }
  function sendGif(url: string) { wsSend({ type: "gif", url }); setGifOpen(false); setGifQ(""); setGifs([]); }
  function sendImg(url: string) { if (!url.startsWith("https://")) { alert("Must be an https:// URL"); return; } wsSend({ type: "image", url }); setImgDialogOpen(false); setImgUrl(""); }

  function handleInput(val: string) {
    setInput(val);
    const m = val.match(/@([a-z0-9_]*)$/i);
    if (m) { setMentionQ(m[1].toLowerCase()); setMentionOpen(true); }
    else setMentionOpen(false);
  }

  const mentionList = useMemo(() =>
    online.filter(u => u.username !== myProfile?.username && (!mentionQ || u.username.includes(mentionQ) || u.displayName.toLowerCase().includes(mentionQ))).slice(0, 6),
    [online, mentionQ, myProfile]
  );

  function insertMention(uname: string) {
    setInput(prev => prev.replace(/@([a-z0-9_]*)$/i, `@${uname} `));
    setMentionOpen(false);
    inputRef.current?.focus();
  }

  function loadProfile(uname: string) {
    fetch(`${API}/profile/${uname}`).then(r => r.json()).then(d => { if (!d.error) setProfileModal(d); }).catch(() => {});
  }

  function logout() {
    localStorage.removeItem(TOKEN_KEY); setToken(null); setMyProfile(null); setMsgs([]); setPins([]); setOnline([]);
    if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.close(); }
    if (reconnRef.current) clearTimeout(reconnRef.current);
    setWsStatus("disconnected"); setAuthReady(true);
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  if (!authReady) return <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#0d0d14", color: "#6b6b8a", fontSize: 14 }}>Connecting…</div>;
  if (!token || !myProfile) return <AuthScreen onAuth={(tok, prof) => { setToken(tok); setMyProfile(prof); setAuthReady(false); setTimeout(() => connect(tok), 50); }} />;

  const isOwner = myProfile.isOwner;
  const isPinned = (id: string) => pins.some(p => p.id === id);

  function renderText(text: string) {
    return text.split(/(@[a-z0-9_]+)/gi).map((part, i) =>
      /^@[a-z0-9_]+$/i.test(part)
        ? <span key={i} style={{ color: "#f5c518", background: part.slice(1).toLowerCase() === myProfile.username ? "#f5c51818" : "transparent", borderRadius: 3, padding: "0 1px", fontWeight: 600 }}>{part}</span>
        : <span key={i}>{part}</span>
    );
  }

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "#0d0d14" }} onClick={() => { setCtx(null); }}>

      {/* ── Header ── */}
      <div style={{ height: 48, background: "#14141e", borderBottom: "1px solid #2a2a3a", display: "flex", alignItems: "center", padding: "0 14px", gap: 10, flexShrink: 0 }}>
        <span style={{ fontWeight: 900, letterSpacing: "0.12em", color: "#f5c518", fontSize: 14, flex: 1 }}>⚡ XENO CHAT</span>
        <span style={{ fontSize: 11, fontWeight: 600, color: wsStatus === "connected" ? "#22c55e" : wsStatus === "connecting" ? "#f5c518" : "#ef4444", display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: "currentColor", display: "inline-block" }} />
          {wsStatus === "connected" ? `${online.length} online` : wsStatus === "connecting" ? "Connecting…" : "Reconnecting…"}
        </span>
        <button onClick={() => setSidebarOpen(v => !v)} title="Online users" style={{ background: "none", border: "none", color: sidebarOpen ? "#f5c518" : "#4a4a6a", cursor: "pointer", padding: 5 }}><Users size={16} /></button>
        <button onClick={() => setSettingsOpen(true)} title="Edit profile" style={{ background: "none", border: "none", color: "#4a4a6a", cursor: "pointer", padding: 5 }}><Settings size={16} /></button>
        <div onClick={() => loadProfile(myProfile.username)} style={{ cursor: "pointer" }}><Avatar p={myProfile} size={28} /></div>
        <button onClick={logout} title="Log out" style={{ background: "none", border: "none", color: "#4a4a6a", cursor: "pointer", padding: 5 }}><LogOut size={15} /></button>
      </div>

      {/* ── Pins ── */}
      {pins.length > 0 && (
        <div style={{ background: "#12122080", borderBottom: "1px solid #2a2a3a", padding: "6px 14px", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, cursor: "pointer" }} onClick={() => setPinsOpen(v => !v)}>
            <Pin size={11} color="#f5c518" /><span style={{ color: "#f5c518", fontSize: 11, fontWeight: 700, flex: 1 }}>{pins.length} PINNED</span>
            <ChevronDown size={11} color="#6b6b8a" style={{ transform: pinsOpen ? "rotate(180deg)" : "none", transition: ".2s" }} />
          </div>
          {pinsOpen && pins.map(p => (
            <div key={p.id} style={{ display: "flex", alignItems: "flex-start", gap: 8, marginTop: 6, background: "#0d0d1460", borderRadius: 8, padding: "6px 10px" }}>
              <Pin size={10} color={p.color} style={{ marginTop: 2, flexShrink: 0 }} />
              <span style={{ flex: 1, fontSize: 12, color: "#b0b0c8" }}><span style={{ color: p.color, fontWeight: 700 }}>{p.displayName}: </span>{p.text}</span>
              {isOwner && <button onClick={() => wsSend({ type: "admin_unpin", msgId: p.id })} style={{ background: "none", border: "none", color: "#4a4a6a", cursor: "pointer", padding: 2 }}><X size={11} /></button>}
            </div>
          ))}
        </div>
      )}

      {/* ── Body ── */}
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>

        {/* Messages */}
        <div ref={listRef} style={{ flex: 1, overflowY: "auto", padding: "10px 0" }}>
          {msgs.length === 0 && wsStatus === "connected" && (
            <div style={{ textAlign: "center", color: "#3a3a5a", padding: "60px 20px" }}>
              <div style={{ fontSize: 42, marginBottom: 10 }}>💬</div>
              <div style={{ fontWeight: 700, fontSize: 15 }}>Be the first to say something!</div>
            </div>
          )}
          {msgs.map((msg, i) => {
            const prev = msgs[i - 1];
            const grouped = !!(prev && prev.type !== "system" && msg.type !== "system" && prev.username === msg.username && msg.ts - prev.ts < 300_000);
            const mentioned = myProfile && msg.mentions?.includes(myProfile.username);

            if (msg.type === "system") {
              return <div key={msg.id} style={{ textAlign: "center", color: "#3a3a5a", fontSize: 11, padding: "2px 0", userSelect: "none" }}>{msg.text}</div>;
            }

            return (
              <div key={msg.id} onContextMenu={e => { e.preventDefault(); setCtx({ x: Math.min(e.clientX, window.innerWidth - 190), y: Math.min(e.clientY, window.innerHeight - 170), msg }); }}
                style={{ display: "flex", gap: 10, padding: grouped ? "1px 14px" : "7px 14px 1px", alignItems: "flex-start", background: mentioned ? "#f5c51806" : "transparent", borderLeft: `2px solid ${mentioned ? "#f5c51870" : "transparent"}` }}>
                {grouped
                  ? <div style={{ width: 36, flexShrink: 0 }} />
                  : <Avatar p={msg} size={36} onClick={() => loadProfile(msg.username)} />}
                <div style={{ flex: 1, minWidth: 0 }}>
                  {!grouped && (
                    <div style={{ display: "flex", alignItems: "baseline", gap: 7, marginBottom: 2, flexWrap: "wrap" }}>
                      <span onClick={() => loadProfile(msg.username)} style={{ color: msg.color, fontWeight: 700, fontSize: 14, cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}>
                        {msg.displayName}
                        {online.find(u => u.username === msg.username)?.isOwner && <Crown size={11} color="#f5c518" />}
                      </span>
                      <span style={{ color: "#3a3a5a", fontSize: 10 }}>{fmtTime(msg.ts)}</span>
                      {isPinned(msg.id) && <Pin size={10} color="#f5c518" />}
                    </div>
                  )}
                  {msg.type === "msg" && <div style={{ color: "#d0d0e0", fontSize: 14, lineHeight: 1.55, wordBreak: "break-word" }}>{renderText(msg.text ?? "")}</div>}
                  {(msg.type === "gif" || msg.type === "image") && <img src={msg.url} alt="" style={{ maxWidth: 320, maxHeight: 240, borderRadius: 10, display: "block", marginTop: 2, border: "1px solid #2a2a3a" }} />}
                </div>
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>

        {/* Online sidebar */}
        {sidebarOpen && (
          <div style={{ width: 176, background: "#0e0e18", borderLeft: "1px solid #2a2a3a", overflowY: "auto", flexShrink: 0, padding: "10px 0" }}>
            <div style={{ color: "#3a3a5a", fontSize: 10, fontWeight: 700, letterSpacing: "0.14em", padding: "0 12px 8px", textTransform: "uppercase" }}>Online — {online.length}</div>
            {online.map(u => (
              <div key={u.username} onClick={() => loadProfile(u.username)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 10px", cursor: "pointer", margin: "0 4px", borderRadius: 8, transition: ".1s" }}
                onMouseEnter={e => (e.currentTarget.style.background = "#1a1a2e")} onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                <Avatar p={u} size={28} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ color: u.color, fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center", gap: 3 }}>
                    {u.isOwner && <Crown size={9} color="#f5c518" />}
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{u.displayName}</span>
                  </div>
                  <div style={{ color: "#3a3a5a", fontSize: 10 }}>@{u.username}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Overlays ── */}

      {/* GIF panel */}
      {gifOpen && (
        <div style={{ position: "absolute", bottom: 58, left: 14, background: "#14141e", border: "1px solid #2a2a3a", borderRadius: 14, width: 360, maxHeight: 320, display: "flex", flexDirection: "column", zIndex: 50, boxShadow: "0 12px 40px #000b", overflow: "hidden" }} onClick={e => e.stopPropagation()}>
          <div style={{ padding: 10, borderBottom: "1px solid #2a2a3a" }}>
            <input value={gifQ} onChange={e => setGifQ(e.target.value)} placeholder="Search GIFs…" autoFocus style={{ width: "100%", background: "#0d0d14", border: "1px solid #2a2a3a", borderRadius: 8, padding: "7px 12px", color: "#e0e0e8", fontSize: 13, outline: "none", boxSizing: "border-box" }} />
          </div>
          <div style={{ overflowY: "auto", flex: 1, padding: 8, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 5 }}>
            {gifLoading && <div style={{ gridColumn: "1/-1", textAlign: "center", color: "#3a3a5a", padding: 24 }}>Searching…</div>}
            {!gifLoading && gifs.length === 0 && gifQ && <div style={{ gridColumn: "1/-1", textAlign: "center", color: "#3a3a5a", padding: 24 }}>No results</div>}
            {!gifLoading && !gifQ && <div style={{ gridColumn: "1/-1", textAlign: "center", color: "#3a3a5a", padding: 24 }}>Type to search GIFs</div>}
            {gifs.map(g => (
              <img key={g.id} src={g.preview} alt="" onClick={() => sendGif(g.url)} style={{ width: "100%", aspectRatio: "4/3", objectFit: "cover", borderRadius: 8, cursor: "pointer", border: "2px solid transparent", transition: "border .1s" }}
                onMouseEnter={e => (e.currentTarget.style.borderColor = "#f5c518")} onMouseLeave={e => (e.currentTarget.style.borderColor = "transparent")} />
            ))}
          </div>
        </div>
      )}

      {/* Image URL dialog */}
      {imgDialogOpen && (
        <div style={{ position: "absolute", bottom: 58, left: 14, background: "#1a1a2e", border: "1px solid #2a2a3a", borderRadius: 12, padding: 14, width: 340, zIndex: 50, boxShadow: "0 8px 32px #000a" }} onClick={e => e.stopPropagation()}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#6b6b8a", marginBottom: 8 }}>Share an Image URL</div>
          <div style={{ display: "flex", gap: 8 }}>
            <input value={imgUrl} onChange={e => setImgUrl(e.target.value)} placeholder="https://i.imgur.com/..." autoFocus onKeyDown={e => e.key === "Enter" && sendImg(imgUrl)}
              style={{ flex: 1, background: "#0d0d14", border: "1px solid #2a2a3a", borderRadius: 8, padding: "7px 10px", color: "#e0e0e8", fontSize: 12, outline: "none" }} />
            <button onClick={() => sendImg(imgUrl)} style={{ background: "#f5c518", color: "#1a1206", border: "none", borderRadius: 8, padding: "0 12px", cursor: "pointer", fontWeight: 700 }}><Send size={13} /></button>
          </div>
        </div>
      )}

      {/* Mention dropdown */}
      {mentionOpen && mentionList.length > 0 && (
        <div style={{ position: "absolute", bottom: 58, left: 90, background: "#1a1a2e", border: "1px solid #2a2a3a", borderRadius: 10, overflow: "hidden", zIndex: 50, minWidth: 200, boxShadow: "0 8px 24px #000a" }} onClick={e => e.stopPropagation()}>
          {mentionList.map(u => (
            <div key={u.username} onClick={() => insertMention(u.username)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", cursor: "pointer", transition: ".1s" }}
              onMouseEnter={e => (e.currentTarget.style.background = "#2a2a3a")} onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
              <Avatar p={u} size={24} />
              <div><div style={{ color: u.color, fontSize: 13, fontWeight: 600 }}>{u.displayName}</div><div style={{ color: "#3a3a5a", fontSize: 10 }}>@{u.username}</div></div>
            </div>
          ))}
        </div>
      )}

      {/* Context menu */}
      {ctx && (
        <div style={{ position: "fixed", left: ctx.x, top: ctx.y, background: "#1a1a2e", border: "1px solid #2a2a3a", borderRadius: 10, zIndex: 100, overflow: "hidden", minWidth: 175, boxShadow: "0 12px 40px #000c" }} onClick={e => e.stopPropagation()}>
          {ctx.msg.text && (
            <div onClick={() => { navigator.clipboard.writeText(ctx.msg.text ?? ""); setCtx(null); }} style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 14px", cursor: "pointer", color: "#d0d0e0", fontSize: 13 }} onMouseEnter={e => (e.currentTarget.style.background = "#2a2a3a")} onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
              <Check size={13} /> Copy Text
            </div>
          )}
          {isOwner && ctx.msg.type === "msg" && !isPinned(ctx.msg.id) && (
            <div onClick={() => { wsSend({ type: "admin_pin", msgId: ctx.msg.id }); setCtx(null); }} style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 14px", cursor: "pointer", color: "#f5c518", fontSize: 13 }} onMouseEnter={e => (e.currentTarget.style.background = "#f5c51815")} onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
              <Pin size={13} /> Pin Message
            </div>
          )}
          {isOwner && isPinned(ctx.msg.id) && (
            <div onClick={() => { wsSend({ type: "admin_unpin", msgId: ctx.msg.id }); setCtx(null); }} style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 14px", cursor: "pointer", color: "#6b6b8a", fontSize: 13 }} onMouseEnter={e => (e.currentTarget.style.background = "#2a2a3a")} onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
              <Pin size={13} /> Unpin
            </div>
          )}
          {isOwner && (
            <div onClick={() => { wsSend({ type: "admin_delete", msgId: ctx.msg.id }); setCtx(null); }} style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 14px", cursor: "pointer", color: "#ef4444", fontSize: 13 }} onMouseEnter={e => (e.currentTarget.style.background = "#ef444415")} onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
              <Trash2 size={13} /> Delete Message
            </div>
          )}
          {isOwner && ctx.msg.username && ctx.msg.username !== "xenoking" && ctx.msg.username !== myProfile.username && (
            <div onClick={() => { if (confirm(`Ban @${ctx.msg.username}?`)) { wsSend({ type: "admin_ban", username: ctx.msg.username }); } setCtx(null); }} style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 14px", cursor: "pointer", color: "#ef4444", fontSize: 13, borderTop: "1px solid #2a2a3a" }} onMouseEnter={e => (e.currentTarget.style.background = "#ef444415")} onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
              <Ban size={13} /> Ban @{ctx.msg.username}
            </div>
          )}
        </div>
      )}

      {/* ── Input bar ── */}
      <div style={{ padding: "8px 12px", background: "#14141e", borderTop: "1px solid #2a2a3a", flexShrink: 0, display: "flex", alignItems: "center", gap: 8 }}>
        <button onClick={() => { setImgDialogOpen(v => !v); setGifOpen(false); }} title="Share image" style={{ background: "none", border: "none", color: imgDialogOpen ? "#f5c518" : "#4a4a6a", cursor: "pointer", padding: 5, flexShrink: 0 }}><ImagePlus size={17} /></button>
        <button onClick={() => { setGifOpen(v => !v); setImgDialogOpen(false); }} title="GIF" style={{ background: gifOpen ? "#f5c518" : "none", color: gifOpen ? "#1a1206" : "#4a4a6a", border: "none", borderRadius: 6, cursor: "pointer", padding: "3px 6px", fontWeight: 800, fontSize: 11, flexShrink: 0 }}>GIF</button>
        <button onClick={() => { const v = input + "@"; setInput(v); handleInput(v); inputRef.current?.focus(); }} title="Mention @" style={{ background: "none", border: "none", color: "#4a4a6a", cursor: "pointer", padding: 5, flexShrink: 0 }}><AtSign size={16} /></button>
        <input ref={inputRef} value={input} onChange={e => handleInput(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMsg(); } if (e.key === "Escape") { setMentionOpen(false); setGifOpen(false); setImgDialogOpen(false); } }}
          placeholder="Message the community…"
          style={{ flex: 1, background: "#0d0d14", border: "1px solid #2a2a3a", borderRadius: 10, padding: "9px 14px", color: "#e0e0e8", fontSize: 14, outline: "none", fontFamily: "inherit" }}
        />
        <button onClick={sendMsg} disabled={!input.trim() || wsStatus !== "connected"}
          style={{ background: input.trim() && wsStatus === "connected" ? "#f5c518" : "#1e1e28", color: input.trim() && wsStatus === "connected" ? "#1a1206" : "#3a3a5a", border: "1px solid #2a2a3a", borderRadius: 10, padding: "9px 13px", cursor: input.trim() ? "pointer" : "default", flexShrink: 0, transition: "all .15s" }}>
          <Send size={16} />
        </button>
      </div>

      {/* ── Modals ── */}
      {profileModal && <ProfileModal profile={profileModal} myProfile={myProfile} onClose={() => setProfileModal(null)} onBan={u => { wsSend({ type: "admin_ban", username: u }); setProfileModal(null); }} />}
      {settingsOpen && <SettingsModal profile={myProfile} token={token!} onClose={() => setSettingsOpen(false)} onSaved={p => { setMyProfile(p); setSettingsOpen(false); }} />}
    </div>
  );
}
