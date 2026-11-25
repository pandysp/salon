// The comments room's rules: what each identity may append, and the gate for pi. Pure functions over the room's stored
// messages (oldest first, each stamped { seq, ts, from } by the room), used by room.js for sockets and by the MCP tools.
//
// Messages (the room stamps seq, ts, from; anything else a client sends is dropped by checkComment):
//   { type: "comment", id, text, version?, forPi? }  owner or invited guest (via the shell); forPi: false (owner only) keeps it from pi
//                                             until forwarded
//   { type: "forward", comment }              owner only: hands a guest's comment to pi
//   { type: "reply", comment, text }          pi only (MCP reply_comment), on a thread pi can see
//   { type: "resolve", comment }              pi only (MCP resolve_comment), on a thread pi can see
//
// The gate (spec): only comments whose `from` is the owner (unless sent with forPi: false), or that the owner forwarded, reach pi, by push and by get_comments
// alike. agentItems() is that gate; both paths call it, nothing else decides what pi sees.
export const MAX_TEXT = 4000;

const who = (from) => (from === "owner" ? "owner" : from === "agent" ? "agent" : "guest"); // only these hold a writing socket (R10)
const text = (v) => typeof v === "string" && v.trim().length > 0 && v.length <= MAX_TEXT;
const ref = (v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v);

// Returns the message to store (only the known fields) or throws an Error with status 400 saying why it is refused.
export function checkComment(from, msg, messages) {
  const by = who(from);
  const refuse = (why) => { throw Object.assign(new Error(`comments: ${why}`), { status: 400 }); }; // a refusal, like UserError (no import: the shell bundles this file)
  const all = new Map(messages.filter((m) => m.type === "comment").map((m) => [m.id, m]));
  switch (msg.type) {
    case "comment":
      if (by !== "owner" && by !== "guest") refuse(`${by} cannot comment`);
      if (!ref(msg.id) || all.has(msg.id)) refuse("comment id must be new, 1-64 chars [A-Za-z0-9_-]");
      if (!text(msg.text)) refuse(`text must be 1-${MAX_TEXT} chars`);
      if (msg.version !== undefined && !Number.isInteger(msg.version)) refuse("version must be an integer");
      if (msg.forPi !== undefined && (by !== "owner" || typeof msg.forPi !== "boolean")) refuse("forPi is the owner's boolean");
      // stored only when false, so a comment for pi keeps today's shape
      return { type: "comment", id: msg.id, text: msg.text, ...(msg.version !== undefined ? { version: msg.version } : {}), ...(msg.forPi === false ? { forPi: false } : {}) };
    case "forward": {
      if (by !== "owner") refuse("only the owner forwards comments to pi");
      const c = all.get(msg.comment);
      if (!c || (c.from === "owner" && c.forPi !== false)) refuse("forward needs a comment pi does not have yet");
      if (messages.some((m) => m.type === "forward" && m.comment === msg.comment)) refuse("already forwarded");
      return { type: "forward", comment: msg.comment };
    }
    case "reply":
    case "resolve": {
      if (by !== "agent") refuse(`only pi can ${msg.type} (via MCP)`);
      const t = agentItems(messages).find((x) => x.id === msg.comment); // pi acts only on threads it can see
      if (!t) refuse(`no comment ${msg.comment} visible to pi`);
      if (msg.type === "resolve") return { type: "resolve", comment: msg.comment };
      if (!text(msg.text)) refuse(`text must be 1-${MAX_TEXT} chars`);
      return { type: "reply", comment: msg.comment, text: msg.text };
    }
    default:
      return refuse(`unknown message type ${JSON.stringify(msg.type)}`);
  }
}

// Every thread in the room, for the shell (owner and guests see all comments of the artifact).
export function threads(messages) {
  const byId = new Map(), out = [];
  for (const m of messages) {
    if (m.type === "comment") {
      const t = { id: m.id, text: m.text, from: m.from, version: m.version ?? null, ts: m.ts, seq: m.seq, forPi: m.forPi !== false, forwarded: false, resolved: false, replies: [] };
      byId.set(m.id, t); out.push(t);
    } else if (m.type === "forward" && byId.has(m.comment)) { byId.get(m.comment).forwarded = true; byId.get(m.comment).forwardSeq = m.seq; }
    else if (m.type === "reply" && byId.has(m.comment)) byId.get(m.comment).replies.push({ from: m.from, text: m.text, ts: m.ts, seq: m.seq });
    else if (m.type === "resolve" && byId.has(m.comment)) byId.get(m.comment).resolved = true;
  }
  return out;
}

// What pi may see: the owner's threads (except those sent with forPi: false) and forwarded ones, with pi's/the owner's replies and the resolved state. `seq` is the
// room seq at which the thread became visible to pi (the comment for the owner's, the forward for a guest's), so the bridge's
// "last delivered seq" also covers a guest comment forwarded long after it was written.
export function agentItems(messages) {
  return threads(messages)
    .filter((t) => (t.from === "owner" && t.forPi) || t.forwarded)
    .map(({ forwardSeq, forPi, ...t }) => ({ ...t, seq: forwardSeq ?? t.seq, replies: t.replies.filter((r) => r.from === "owner" || r.from === "agent") }))
    .sort((a, b) => a.seq - b.seq);
}
