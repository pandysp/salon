// Copied from the bake-off room; the protocol is unchanged, plus:
//  - `from`: the Worker authenticates the viewer and passes the id in the internal header x-room-from; the room keeps it in the
//    socket attachment (survives hibernation) and stamps every stored message with it. A client-sent `from` is overwritten.
//    No x-room-from = a link visitor: the socket gets history and broadcasts, and any frame it sends closes it (4003 "view
//    only"; R10). The Worker also sends none for the app room of a version with viewer tools
//    (DoD 6) .
//  - `$`-types are reserved for the platform: clients cannot send them (the platform sends none since T16; D10).
//  - caps: 64 KB per message, 100 messages per 10 s per socket (close 4008), 1 MiB per live room (close 4009 "room full";
//    review F4a). Every row is costed as it appears in the history frame, so the frame a
//    connecting viewer gets stays under the room cap; a rollback that would restore more is refused.
//  - `seq()` and `rollback(seq)` for versions: after rollback(s) the live room is exactly the messages with seq <= s, wherever
//    they were: later live messages move to the `archive` table, archived ones with seq <= s come back (so a rollback can be
//    undone by rolling forward). Nothing is ever deleted; seq numbers are never reused. Every open socket gets the new history.
// One Durable Object per room. SQLite stores every client message in arrival order; hibernatable WebSockets.
// Protocol (JSON text frames):
//   client -> server: any JSON object whose `type` does not start with "$" (the room stores and rebroadcasts it)
//   server -> client on connect and after a rollback: { type: "history", messages: [<stored message>, ...] } (oldest first)
//   server -> all clients, per msg: <the client's object> + { seq, ts, from }   (all three server-stamped)
//   server closes every socket with 4012 "version changed" when the artifact gets a new version (versionChanged)
//  - comments rooms: the Worker passes the kind in x-room-kind (kept in the socket
//    attachment). There every message must pass checkComment() (comments.js), and pi's socket (from "agent") never sees the
//    raw log: it gets { type: "history", messages: agentItems(...) } on connect and after every append (the gate).
import { DurableObject } from "cloudflare:workers";
import { checkComment, agentItems } from "./comments.js";

const MAX_MESSAGE_BYTES = 64 * 1024;
const RATE_WINDOW_MS = 10_000, RATE_MAX = 100; // per socket; an evicted room forgets its counters, which only resets the window
const MAX_ROOM_BYTES = 1024 * 1024; // the live room (= every history frame) stays under this; the archive is not counted
// a stored row's size in the history frame: its body, its from, and 64 bytes for `,"seq":…,"ts":…,"from":""` and separators
const COST = "length(CAST(body AS BLOB)) + length(CAST(from_id AS BLOB)) + 64";
const utf8 = (s) => new TextEncoder().encode(s).length;
// a refusal with a status, like UserError (comments.js explains why no import); 409 is "room full", nothing else here uses it
const full = (msg) => Object.assign(new Error(msg), { status: 409 });

export class Room extends DurableObject {
  #rate = new Map(); // socket -> { start, n }
  constructor(ctx, env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS msgs (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, from_id TEXT NOT NULL, body TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS archive (seq INTEGER PRIMARY KEY, ts INTEGER NOT NULL, from_id TEXT NOT NULL, body TEXT NOT NULL, archived_at INTEGER NOT NULL, reason TEXT NOT NULL)");
  }
  history() {
    return this.ctx.storage.sql.exec("SELECT seq, ts, from_id, body FROM msgs ORDER BY seq").toArray()
      .map((r) => ({ ...JSON.parse(r.body), seq: r.seq, ts: r.ts, from: r.from_id }));
  }
  async fetch(req) {
    const from = req.headers.get("x-room-from"); // null = view only
    const kind = req.headers.get("x-room-kind") ?? "app";
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ from, kind });
    pair[1].send(this.#historyFor({ from, kind }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  async webSocketMessage(ws, message) {
    if (ws.readyState !== WebSocket.OPEN) return; // closed by us (rate limit, bad message): ignore what was still queued
    if (ws.deserializeAttachment().from === null) { ws.close(4003, "view only"); return; }
    let msg;
    try {
      if (typeof message !== "string") throw new Error("binary frame");
      if (message.length > MAX_MESSAGE_BYTES) throw new Error("message too large");
      const now = Date.now(), r = this.#rate.get(ws);
      if (!r || now - r.start > RATE_WINDOW_MS) this.#rate.set(ws, { start: now, n: 1 });
      else if (++r.n > RATE_MAX) { this.#rate.delete(ws); ws.close(4008, "rate limit"); return; }
      msg = JSON.parse(message);
      if (msg === null || typeof msg !== "object" || Array.isArray(msg)) throw new Error("not a JSON object");
      if (typeof msg.type === "string" && msg.type.startsWith("$")) throw new Error("$-types are reserved for the platform");
      const { kind, from } = ws.deserializeAttachment();
      if (kind === "comments") msg = checkComment(from, msg, this.history());
    } catch (e) {
      ws.close(4003, ("invalid message: " + e.message).slice(0, 120)); // 4003, not the bake-off's 1003: celld 0.6.3 only allows 1000 and 3000-4999
      return;
    }
    try { this.#append(ws.deserializeAttachment(), msg); }
    catch (e) { if (e.status !== 409) throw e; ws.close(4009, "room full"); }
  }
  #size(where = "", ...args) {
    return this.ctx.storage.sql.exec(`SELECT COALESCE(SUM(${COST}), 0) AS b FROM msgs ${where}`, ...args).one().b;
  }
  #append({ from, kind }, msg) {
    const ts = Date.now(), body = JSON.stringify(msg);
    if (this.#size() + utf8(body) + utf8(from) + 64 > MAX_ROOM_BYTES)
      throw full(`room full (${MAX_ROOM_BYTES} bytes); only a rollback frees space`);
    const seq = this.ctx.storage.sql.exec("INSERT INTO msgs (ts, from_id, body) VALUES (?, ?, ?) RETURNING seq", ts, from, body).one().seq;
    const stored = { ...msg, seq, ts, from };
    if (kind !== "comments") { this.#broadcast(JSON.stringify(stored)); return stored; }
    const agentFrame = this.#historyFor({ from: "agent", kind });
    for (const peer of this.ctx.getWebSockets()) peer.send(peer.deserializeAttachment()?.from === "agent" ? agentFrame : JSON.stringify(stored));
    return stored;
  }
  // the one place that decides what a socket's history frame holds: pi (from "agent") in a comments room gets only its gated view
  #historyFor({ from, kind }) {
    const all = this.history();
    return JSON.stringify({ type: "history", messages: kind === "comments" && from === "agent" ? agentItems(all) : all });
  }
  webSocketClose(ws) { this.#rate.delete(ws); }
  #broadcast(text) { for (const peer of this.ctx.getWebSockets()) peer.send(text); }

  // ---- platform RPC (called by the Worker / Platform object, never reachable by clients) ----
  seq() { return this.ctx.storage.sql.exec("SELECT COALESCE(MAX(seq), 0) AS s FROM msgs").one().s; }
  // comments rooms only: pi's MCP tools (reply_comment, resolve_comment, get_comments) go through the same rules and gate
  postComment(from, msg) { return this.#append({ from, kind: "comments" }, checkComment(from, msg, this.history())); }
  agentView() { return agentItems(this.history()); }
  // the Worker decides each reconnecting socket's `from` again for the version its viewer now sees (DoD 6, T16)
  versionChanged() { for (const ws of this.ctx.getWebSockets()) ws.close(4012, "version changed"); }
  rollback(toSeq, reason) {
    const sql = this.ctx.storage.sql, now = Date.now();
    const after = this.#size("WHERE seq <= ?", toSeq) + sql.exec(`SELECT COALESCE(SUM(${COST}), 0) AS b FROM archive WHERE seq <= ?`, toSeq).one().b;
    if (after > MAX_ROOM_BYTES) throw full(`rollback would put ${after} bytes in the room (cap ${MAX_ROOM_BYTES})`);
    sql.exec("INSERT INTO archive (seq, ts, from_id, body, archived_at, reason) SELECT seq, ts, from_id, body, ?, ? FROM msgs WHERE seq > ?", now, reason, toSeq);
    const archived = sql.exec("DELETE FROM msgs WHERE seq > ? RETURNING seq", toSeq).toArray().length;
    sql.exec("INSERT INTO msgs (seq, ts, from_id, body) SELECT seq, ts, from_id, body FROM archive WHERE seq <= ?", toSeq);
    const restored = sql.exec("DELETE FROM archive WHERE seq <= ? RETURNING seq", toSeq).toArray().length;
    this.#broadcast(JSON.stringify({ type: "history", messages: this.history() }));
    return { archived, restored };
  }
  archived() {
    return this.ctx.storage.sql.exec("SELECT seq, ts, from_id, body, archived_at, reason FROM archive ORDER BY seq").toArray()
      .map((r) => ({ ...JSON.parse(r.body), seq: r.seq, ts: r.ts, from: r.from_id, archived_at: r.archived_at, reason: r.reason }));
  }
}
