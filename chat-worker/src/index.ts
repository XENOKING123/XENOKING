export interface Env {
  CHAT_ROOM: DurableObjectNamespace;
}

const OWNER = "xenoking";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

interface UserProfile {
  username: string;
  displayName: string;
  passwordHash: string;
  color: string;
  bio: string;
  avatarUrl: string;
  bannerColor: string;
  isOwner: boolean;
  joinedAt: number;
}

interface ChatMessage {
  type: "msg" | "gif" | "image" | "system";
  id: string;
  username: string;
  displayName: string;
  color: string;
  avatarUrl: string;
  text?: string;
  url?: string;
  ts: number;
  mentions: string[];
}

interface PinnedMessage {
  id: string;
  username: string;
  displayName: string;
  color: string;
  text: string;
  ts: number;
  pinnedBy: string;
  pinnedAt: number;
}

interface WSSession {
  username: string;
  displayName: string;
  color: string;
  avatarUrl: string;
  isOwner: boolean;
  authed: boolean;
  msgTs: number[];
}

export class ChatRoom {
  private state: DurableObjectState;
  private sessions = new Map<WebSocket, WSSession>();
  private history: ChatMessage[] = [];

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (req.headers.get("Upgrade") === "websocket") return this.handleWS();

    let res: Response;
    if (url.pathname === "/register" && req.method === "POST") res = await this.handleRegister(req);
    else if (url.pathname === "/login" && req.method === "POST") res = await this.handleLogin(req);
    else if (url.pathname.startsWith("/profile/") && req.method === "GET") res = await this.handleGetProfile(url.pathname.slice(9).toLowerCase());
    else if (url.pathname === "/profile" && req.method === "PATCH") res = await this.handleUpdateProfile(req);
    else if (url.pathname === "/pins" && req.method === "GET") {
      const pins = (await this.state.storage.get<PinnedMessage[]>("pins")) ?? [];
      res = new Response(JSON.stringify(pins), { headers: { "Content-Type": "application/json" } });
    } else res = new Response("xeno-chat", { status: 200 });

    const h = new Headers(res.headers);
    Object.entries(CORS).forEach(([k, v]) => h.set(k, v));
    return new Response(res.body, { status: res.status, headers: h });
  }

  private json(data: unknown, status = 200) {
    return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
  }

  private async hashPw(pw: string, salt: string): Promise<string> {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: enc.encode(salt), iterations: 100_000, hash: "SHA-256" }, key, 256);
    return btoa(String.fromCharCode(...new Uint8Array(bits)));
  }

  private tok(): string {
    const a = new Uint8Array(32);
    crypto.getRandomValues(a);
    return btoa(String.fromCharCode(...a)).replace(/[^a-zA-Z0-9]/g, "").slice(0, 48);
  }

  private safe(p: UserProfile) {
    const { passwordHash: _, ...rest } = p;
    return rest;
  }

  private async authedUser(req: Request): Promise<UserProfile | null> {
    const token = req.headers.get("Authorization")?.replace("Bearer ", "").trim();
    if (!token) return null;
    const s = await this.state.storage.get<{ username: string; expires: number }>(`session:${token}`);
    if (!s || s.expires < Date.now()) return null;
    return (await this.state.storage.get<UserProfile>(`user:${s.username}`)) ?? null;
  }

  private async handleRegister(req: Request): Promise<Response> {
    let body: any;
    try { body = await req.json(); } catch { return this.json({ error: "Invalid JSON" }, 400); }
    const username = String(body.username ?? "").toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 20);
    const password = String(body.password ?? "");
    const displayName = String(body.displayName ?? username).replace(/[<>"]/g, "").trim().slice(0, 32);
    const color = /^#[0-9a-fA-F]{6}$/.test(body.color) ? String(body.color) : "#f5c518";
    if (username.length < 3) return this.json({ error: "Username: 3–20 chars (a-z, 0-9, _)" }, 400);
    if (password.length < 6) return this.json({ error: "Password: at least 6 characters" }, 400);
    if (!displayName) return this.json({ error: "Display name required" }, 400);
    if (await this.state.storage.get(`user:${username}`)) return this.json({ error: "Username already taken" }, 409);
    const salt = this.tok().slice(0, 16);
    const hash = await this.hashPw(password, salt);
    const profile: UserProfile = { username, displayName, passwordHash: `${hash}:${salt}`, color, bio: "", avatarUrl: "", bannerColor: "#1a1a2e", isOwner: username === OWNER, joinedAt: Date.now() };
    await this.state.storage.put(`user:${username}`, profile);
    const token = this.tok();
    await this.state.storage.put(`session:${token}`, { username, expires: Date.now() + 30 * 86_400_000 });
    return this.json({ token, profile: this.safe(profile) }, 201);
  }

  private async handleLogin(req: Request): Promise<Response> {
    let body: any;
    try { body = await req.json(); } catch { return this.json({ error: "Invalid JSON" }, 400); }
    const username = String(body.username ?? "").toLowerCase().trim();
    const password = String(body.password ?? "");
    const profile = await this.state.storage.get<UserProfile>(`user:${username}`);
    if (!profile) return this.json({ error: "Invalid username or password" }, 401);
    const [storedHash, salt] = profile.passwordHash.split(":");
    if ((await this.hashPw(password, salt)) !== storedHash) return this.json({ error: "Invalid username or password" }, 401);
    const banned = (await this.state.storage.get<string[]>("banned")) ?? [];
    if (banned.includes(username)) return this.json({ error: "This account is banned" }, 403);
    if (username === OWNER && !profile.isOwner) { profile.isOwner = true; await this.state.storage.put(`user:${username}`, profile); }
    const token = this.tok();
    await this.state.storage.put(`session:${token}`, { username, expires: Date.now() + 30 * 86_400_000 });
    return this.json({ token, profile: this.safe(profile) });
  }

  private async handleGetProfile(username: string): Promise<Response> {
    const p = await this.state.storage.get<UserProfile>(`user:${username}`);
    if (!p) return this.json({ error: "User not found" }, 404);
    return this.json(this.safe(p));
  }

  private async handleUpdateProfile(req: Request): Promise<Response> {
    const profile = await this.authedUser(req);
    if (!profile) return this.json({ error: "Unauthorized" }, 401);
    let body: any;
    try { body = await req.json(); } catch { return this.json({ error: "Invalid JSON" }, 400); }
    if (body.displayName !== undefined) profile.displayName = String(body.displayName).replace(/[<>"]/g, "").trim().slice(0, 32) || profile.displayName;
    if (/^#[0-9a-fA-F]{6}$/.test(body.color)) profile.color = body.color;
    if (body.bio !== undefined) profile.bio = String(body.bio).slice(0, 250);
    if (body.avatarUrl !== undefined) profile.avatarUrl = String(body.avatarUrl).startsWith("https://") ? String(body.avatarUrl).slice(0, 500) : "";
    if (/^#[0-9a-fA-F]{6}$/.test(body.bannerColor)) profile.bannerColor = body.bannerColor;
    await this.state.storage.put(`user:${profile.username}`, profile);
    for (const [, s] of this.sessions) {
      if (s.username === profile.username) { s.displayName = profile.displayName; s.color = profile.color; s.avatarUrl = profile.avatarUrl; }
    }
    return this.json(this.safe(profile));
  }

  private handleWS(): Response {
    const { 0: client, 1: server } = new WebSocketPair();
    this.state.acceptWebSocket(server);
    this.sessions.set(server, { username: "", displayName: "", color: "", avatarUrl: "", isOwner: false, authed: false, msgTs: [] });
    server.send(JSON.stringify({ type: "welcome" }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    let session = this.sessions.get(ws);
    if (!session) {
      session = { username: "", displayName: "", color: "", avatarUrl: "", isOwner: false, authed: false, msgTs: [] };
      this.sessions.set(ws, session);
      try {
        const att = (ws as any).deserializeAttachment?.();
        if (att?.username) {
          const p = await this.state.storage.get<UserProfile>(`user:${att.username}`);
          if (p) { session.username = p.username; session.displayName = p.displayName; session.color = p.color; session.avatarUrl = p.avatarUrl; session.isOwner = p.isOwner; session.authed = true; }
        }
      } catch {}
      if (!session.authed) { ws.send(JSON.stringify({ type: "need_auth" })); return; }
    }

    let msg: any;
    try { msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)); } catch { return; }

    if (msg.type === "auth") {
      const s = await this.state.storage.get<{ username: string; expires: number }>(`session:${String(msg.token)}`);
      if (!s || s.expires < Date.now()) { ws.send(JSON.stringify({ type: "auth_error", msg: "Session expired. Please log in again." })); return; }
      const banned = (await this.state.storage.get<string[]>("banned")) ?? [];
      if (banned.includes(s.username)) { ws.send(JSON.stringify({ type: "banned" })); ws.close(); return; }
      const p = await this.state.storage.get<UserProfile>(`user:${s.username}`);
      if (!p) { ws.send(JSON.stringify({ type: "auth_error", msg: "Account not found." })); return; }
      session.username = p.username; session.displayName = p.displayName; session.color = p.color; session.avatarUrl = p.avatarUrl; session.isOwner = p.isOwner || p.username === OWNER; session.authed = true;
      try { (ws as any).serializeAttachment?.({ username: p.username }); } catch {}
      const pins = (await this.state.storage.get<PinnedMessage[]>("pins")) ?? [];
      ws.send(JSON.stringify({ type: "authed", profile: this.safe(p), history: this.history.slice(-100), pins }));
      this.broadcast({ type: "join", username: p.username, displayName: p.displayName, color: p.color, avatarUrl: p.avatarUrl, ts: Date.now() });
      this.broadcastOnline();
      return;
    }

    if (!session.authed) { ws.send(JSON.stringify({ type: "need_auth" })); return; }

    const now = Date.now();
    if (!session.isOwner) {
      session.msgTs = session.msgTs.filter(t => now - t < 15_000);
      if (session.msgTs.length >= 10) return;
      session.msgTs.push(now);
    }

    if (msg.type === "msg") {
      const text = String(msg.text ?? "").slice(0, 1000).trim();
      if (!text) return;
      const mentions = [...text.matchAll(/@([a-z0-9_]+)/gi)].map((m: RegExpMatchArray) => m[1].toLowerCase());
      const out: ChatMessage = { type: "msg", id: crypto.randomUUID(), username: session.username, displayName: session.displayName, color: session.color, avatarUrl: session.avatarUrl, text, ts: now, mentions };
      this.pushHistory(out); this.broadcast(out); return;
    }

    if (msg.type === "gif" || msg.type === "image") {
      const url = String(msg.url ?? "");
      if (!url.startsWith("https://")) return;
      const out: ChatMessage = { type: msg.type, id: crypto.randomUUID(), username: session.username, displayName: session.displayName, color: session.color, avatarUrl: session.avatarUrl, url, ts: now, mentions: [] };
      this.pushHistory(out); this.broadcast(out); return;
    }

    if (!session.isOwner) return;

    if (msg.type === "admin_pin") {
      const m = this.history.find(h => h.id === String(msg.msgId));
      if (!m?.text) return;
      const pins = (await this.state.storage.get<PinnedMessage[]>("pins")) ?? [];
      if (pins.find(p => p.id === m.id)) return;
      if (pins.length >= 10) pins.shift();
      const pin: PinnedMessage = { id: m.id, username: m.username, displayName: m.displayName, color: m.color, text: m.text, ts: m.ts, pinnedBy: session.username, pinnedAt: now };
      pins.push(pin); await this.state.storage.put("pins", pins);
      this.broadcast({ type: "pinned", pin }); return;
    }
    if (msg.type === "admin_unpin") {
      const pins = (await this.state.storage.get<PinnedMessage[]>("pins")) ?? [];
      await this.state.storage.put("pins", pins.filter(p => p.id !== String(msg.msgId)));
      this.broadcast({ type: "unpinned", msgId: msg.msgId }); return;
    }
    if (msg.type === "admin_delete") {
      const idx = this.history.findIndex(h => h.id === String(msg.msgId));
      if (idx !== -1) this.history.splice(idx, 1);
      this.broadcast({ type: "deleted", msgId: msg.msgId }); return;
    }
    if (msg.type === "admin_ban") {
      const target = String(msg.username ?? "").toLowerCase();
      if (!target || target === OWNER) return;
      const banned = (await this.state.storage.get<string[]>("banned")) ?? [];
      if (!banned.includes(target)) { banned.push(target); await this.state.storage.put("banned", banned); }
      for (const [ws_, s] of this.sessions) { if (s.username === target) { ws_.send(JSON.stringify({ type: "banned" })); ws_.close(); } }
      const sys: ChatMessage = { type: "system", id: crypto.randomUUID(), username: "SYSTEM", displayName: "SYSTEM", color: "#ef4444", avatarUrl: "", text: `@${target} was banned by an admin.`, ts: now, mentions: [] };
      this.pushHistory(sys); this.broadcast(sys); return;
    }
    if (msg.type === "admin_unban") {
      const target = String(msg.username ?? "").toLowerCase();
      const banned = (await this.state.storage.get<string[]>("banned")) ?? [];
      await this.state.storage.put("banned", banned.filter(u => u !== target));
      const sys: ChatMessage = { type: "system", id: crypto.randomUUID(), username: "SYSTEM", displayName: "SYSTEM", color: "#22c55e", avatarUrl: "", text: `@${target} has been unbanned.`, ts: now, mentions: [] };
      this.pushHistory(sys); this.broadcast(sys); return;
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const s = this.sessions.get(ws); this.sessions.delete(ws);
    if (s?.authed) { this.broadcast({ type: "leave", username: s.username, displayName: s.displayName, ts: Date.now() }); this.broadcastOnline(); }
  }

  async webSocketError(ws: WebSocket): Promise<void> { this.sessions.delete(ws); this.broadcastOnline(); }

  private pushHistory(m: ChatMessage) { this.history.push(m); if (this.history.length > 200) this.history.shift(); }
  private broadcast(m: unknown) { const j = JSON.stringify(m); for (const [ws] of this.sessions) { try { ws.send(j); } catch {} } }
  private broadcastOnline() {
    const users = [...this.sessions.values()].filter(s => s.authed).map(s => ({ username: s.username, displayName: s.displayName, color: s.color, avatarUrl: s.avatarUrl, isOwner: s.isOwner }));
    this.broadcast({ type: "online", count: users.length, users });
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { headers: { ...CORS, "Access-Control-Allow-Headers": "Content-Type, Authorization, Upgrade, Connection" } });
    return env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName("global")).fetch(req);
  },
};
