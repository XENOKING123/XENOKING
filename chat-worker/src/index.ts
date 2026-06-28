export interface Env {
  CHAT_ROOM: DurableObjectNamespace;
}

// ─── Message types ────────────────────────────────────────────────────────

type ChatMsg =
  | { type: "msg"; id: string; nick: string; color: string; text: string; ts: number }
  | { type: "gif"; id: string; nick: string; color: string; url: string; ts: number }
  | { type: "join"; nick: string; color: string; ts: number }
  | { type: "leave"; nick: string; ts: number }
  | { type: "history"; msgs: ChatMsg[] }
  | { type: "online"; count: number }
  | { type: "muted" };

// ─── Durable Object ───────────────────────────────────────────────────────

export class ChatRoom {
  private sessions: Map<WebSocket, { nick: string; color: string; msgTs: number[] }> = new Map();
  private history: ChatMsg[] = [];
  private mutedNicks: Set<string> = new Set();
  private adminNicks: Set<string> = new Set(["XENOKING", "xenoking"]);

  constructor(private state: DurableObjectState) {}

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const { 0: client, 1: server } = new WebSocketPair();
    this.handleSession(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  private handleSession(ws: WebSocket) {
    this.state.acceptWebSocket(ws);
    const session = { nick: "", color: "#f5c518", msgTs: [] as number[] };
    this.sessions.set(ws, session);

    // Send history immediately on connect
    ws.send(JSON.stringify({ type: "history", msgs: this.history.slice(-100) }));
    this.broadcastOnlineCount();
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const session = this.sessions.get(ws);
    if (!session) return;

    let msg: any;
    try { msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)); }
    catch { return; }

    // ── Identify ────────────────────────────────────────────────────────
    if (msg.type === "identify") {
      const nick = String(msg.nick ?? "").slice(0, 24).replace(/[<>"]/g, "").trim();
      const color = /^#[0-9a-fA-F]{6}$/.test(msg.color) ? msg.color : "#f5c518";
      if (!nick) return;
      session.nick = nick;
      session.color = color;

      if (this.mutedNicks.has(nick.toLowerCase())) {
        ws.send(JSON.stringify({ type: "muted" }));
        return;
      }

      const joinMsg: ChatMsg = { type: "join", nick, color, ts: Date.now() };
      this.pushHistory(joinMsg);
      this.broadcast(joinMsg);
      this.broadcastOnlineCount();
      return;
    }

    // Must be identified to send anything else
    if (!session.nick) return;

    // ── Rate limit: max 8 msgs per 15 seconds ──────────────────────────
    const now = Date.now();
    session.msgTs = session.msgTs.filter((t) => now - t < 15_000);
    if (session.msgTs.length >= 8) return; // silently drop
    session.msgTs.push(now);

    // ── Admin commands ──────────────────────────────────────────────────
    if (this.adminNicks.has(session.nick) && msg.type === "admin_mute") {
      const target = String(msg.target ?? "").toLowerCase();
      if (target) {
        this.mutedNicks.add(target);
        const sysMsg: ChatMsg = {
          type: "msg", id: crypto.randomUUID(),
          nick: "SYSTEM", color: "#ef4444",
          text: `${target} has been muted by an admin.`, ts: now,
        };
        this.pushHistory(sysMsg);
        this.broadcast(sysMsg);
      }
      return;
    }

    // ── Text message ────────────────────────────────────────────────────
    if (msg.type === "msg") {
      const text = String(msg.text ?? "").slice(0, 500).trim();
      if (!text) return;
      const out: ChatMsg = {
        type: "msg", id: crypto.randomUUID(),
        nick: session.nick, color: session.color,
        text, ts: now,
      };
      this.pushHistory(out);
      this.broadcast(out);
      return;
    }

    // ── GIF message ─────────────────────────────────────────────────────
    if (msg.type === "gif") {
      const url = String(msg.url ?? "");
      if (!url.startsWith("https://")) return;
      const out: ChatMsg = {
        type: "gif", id: crypto.randomUUID(),
        nick: session.nick, color: session.color,
        url, ts: now,
      };
      this.pushHistory(out);
      this.broadcast(out);
      return;
    }
  }

  async webSocketClose(ws: WebSocket) {
    const session = this.sessions.get(ws);
    this.sessions.delete(ws);
    if (session?.nick) {
      const leaveMsg: ChatMsg = { type: "leave", nick: session.nick, ts: Date.now() };
      this.pushHistory(leaveMsg);
      this.broadcast(leaveMsg);
    }
    this.broadcastOnlineCount();
  }

  async webSocketError(ws: WebSocket) {
    this.sessions.delete(ws);
    this.broadcastOnlineCount();
  }

  private pushHistory(msg: ChatMsg) {
    this.history.push(msg);
    if (this.history.length > 200) this.history.shift();
  }

  private broadcast(msg: ChatMsg) {
    const json = JSON.stringify(msg);
    for (const [ws] of this.sessions) {
      try { ws.send(json); } catch { /* closed */ }
    }
  }

  private broadcastOnlineCount() {
    const count = [...this.sessions.values()].filter((s) => s.nick).length;
    const json = JSON.stringify({ type: "online", count } satisfies ChatMsg);
    for (const [ws] of this.sessions) {
      try { ws.send(json); } catch { /* closed */ }
    }
  }
}

// ─── Router ───────────────────────────────────────────────────────────────

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "Upgrade, Connection",
        },
      });
    }

    // Route all WebSocket upgrades to the single global room
    const room = env.CHAT_ROOM.idFromName("global");
    const stub = env.CHAT_ROOM.get(room);
    const resp = await stub.fetch(req);

    // Add CORS header to allow connection from the Tauri app
    const headers = new Headers(resp.headers);
    headers.set("Access-Control-Allow-Origin", "*");
    return new Response(resp.body, { status: resp.status, headers });
  },
};
