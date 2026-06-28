var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.ts
var ChatRoom = class {
  constructor(state) {
    this.state = state;
  }
  sessions = /* @__PURE__ */ new Map();
  history = [];
  mutedNicks = /* @__PURE__ */ new Set();
  adminNicks = /* @__PURE__ */ new Set(["XENOKING", "xenoking"]);
  async fetch(req) {
    if (req.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.handleSession(server);
    return new Response(null, { status: 101, webSocket: client });
  }
  handleSession(ws) {
    this.state.acceptWebSocket(ws);
    const session = { nick: "", color: "#f5c518", msgTs: [] };
    this.sessions.set(ws, session);
    ws.send(JSON.stringify({ type: "history", msgs: this.history.slice(-100) }));
    this.broadcastOnlineCount();
  }
  async webSocketMessage(ws, raw) {
    const session = this.sessions.get(ws);
    if (!session)
      return;
    let msg;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }
    if (msg.type === "identify") {
      const nick = String(msg.nick ?? "").slice(0, 24).replace(/[<>"]/g, "").trim();
      const color = /^#[0-9a-fA-F]{6}$/.test(msg.color) ? msg.color : "#f5c518";
      if (!nick)
        return;
      session.nick = nick;
      session.color = color;
      if (this.mutedNicks.has(nick.toLowerCase())) {
        ws.send(JSON.stringify({ type: "muted" }));
        return;
      }
      const joinMsg = { type: "join", nick, color, ts: Date.now() };
      this.pushHistory(joinMsg);
      this.broadcast(joinMsg);
      this.broadcastOnlineCount();
      return;
    }
    if (!session.nick)
      return;
    const now = Date.now();
    session.msgTs = session.msgTs.filter((t) => now - t < 15e3);
    if (session.msgTs.length >= 8)
      return;
    session.msgTs.push(now);
    if (this.adminNicks.has(session.nick) && msg.type === "admin_mute") {
      const target = String(msg.target ?? "").toLowerCase();
      if (target) {
        this.mutedNicks.add(target);
        const sysMsg = {
          type: "msg",
          id: crypto.randomUUID(),
          nick: "SYSTEM",
          color: "#ef4444",
          text: `${target} has been muted by an admin.`,
          ts: now
        };
        this.pushHistory(sysMsg);
        this.broadcast(sysMsg);
      }
      return;
    }
    if (msg.type === "msg") {
      const text = String(msg.text ?? "").slice(0, 500).trim();
      if (!text)
        return;
      const out = {
        type: "msg",
        id: crypto.randomUUID(),
        nick: session.nick,
        color: session.color,
        text,
        ts: now
      };
      this.pushHistory(out);
      this.broadcast(out);
      return;
    }
    if (msg.type === "gif") {
      const url = String(msg.url ?? "");
      if (!url.startsWith("https://"))
        return;
      const out = {
        type: "gif",
        id: crypto.randomUUID(),
        nick: session.nick,
        color: session.color,
        url,
        ts: now
      };
      this.pushHistory(out);
      this.broadcast(out);
      return;
    }
  }
  async webSocketClose(ws) {
    const session = this.sessions.get(ws);
    this.sessions.delete(ws);
    if (session?.nick) {
      const leaveMsg = { type: "leave", nick: session.nick, ts: Date.now() };
      this.pushHistory(leaveMsg);
      this.broadcast(leaveMsg);
    }
    this.broadcastOnlineCount();
  }
  async webSocketError(ws) {
    this.sessions.delete(ws);
    this.broadcastOnlineCount();
  }
  pushHistory(msg) {
    this.history.push(msg);
    if (this.history.length > 200)
      this.history.shift();
  }
  broadcast(msg) {
    const json = JSON.stringify(msg);
    for (const [ws] of this.sessions) {
      try {
        ws.send(json);
      } catch {
      }
    }
  }
  broadcastOnlineCount() {
    const count = [...this.sessions.values()].filter((s) => s.nick).length;
    const json = JSON.stringify({ type: "online", count });
    for (const [ws] of this.sessions) {
      try {
        ws.send(json);
      } catch {
      }
    }
  }
};
__name(ChatRoom, "ChatRoom");
var src_default = {
  async fetch(req, env) {
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "Upgrade, Connection"
        }
      });
    }
    const room = env.CHAT_ROOM.idFromName("global");
    const stub = env.CHAT_ROOM.get(room);
    const resp = await stub.fetch(req);
    const headers = new Headers(resp.headers);
    headers.set("Access-Control-Allow-Origin", "*");
    return new Response(resp.body, { status: resp.status, headers });
  }
};
export {
  ChatRoom,
  src_default as default
};
//# sourceMappingURL=index.js.map
