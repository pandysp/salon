// artifact-sdk.js: the only way an artifact talks to the platform. Plain JS, no framework, served by the content host at
// /_sdk/artifact-sdk.js; load it with a classic <script> before your app script. It talks to the shell (the trusted page that
// embeds the artifact) over a MessageChannel; the shell decides what is allowed. The artifact has no network access (CSP).
//
//   artifact.ready                  Promise, resolves once the shell answered (viewer is known)
//   artifact.viewer                 { id, kind: "owner" | "guest" | "link", name } (null until ready). "link" = a link
//                                   visitor (only the link, no grant; id and name null): it receives the room, but
//                                   room.send does nothing, so hide inputs then (R10)
//     .canWrite                     true if room.send reaches the room: show inputs (e.g. vote buttons) only then. Link visitors
//                                   get true while the owner's switch "link visitors may write" is on; each browser is then one
//                                   `from` ("v:…"), but one vote per phone is best effort (a new browser = a new id). (R11)
//   artifact.room                   the artifact's shared room, same shape as the bake-off room-client:
//     .send(obj)                    obj: a JSON object; `type` must not start with "$". The server stamps seq, ts and `from`.
//                                   A version that declares viewer tools has a read-only room (DoD 6: one viewer's data must
//                                   not reach another); a send closes the socket (4003).
//     .onMessage(cb) -> unsubscribe cb({ type: "history", messages }) first (and again after every reconnect or rollback),
//                                   then every message as the room broadcasts it
//     .onStatus(cb)  -> unsubscribe cb("connecting" | "connected" | "closed"), called at once with the current status
//   artifact.tools.call(name, args) Promise<{ ok, result? , error?, message? }>; only tools declared in the manifest work.
//                                   result = the MCP result ({ content: [{ type: "text", text }], structuredContent? }).
//                                   Owner tools take no args (pinned in the manifest). error (chunk 3):
//                                   "declined" (the viewer said no to this page's tools), "not_connected" (the shell shows a
//                                   connect link), "owner_not_connected" (an owner query whose server the owner has not connected), "consent_required", "not_declared", "args_pinned", "not_read_only",
//                                   "unknown_tool", "upstream_error", "view_only" (link visitors; R10)
//
// Comment mode: the shell may switch the page into comment mode ("comment.mode"
// over the port). Then the SDK frames the hovered element and a click picks it instead of acting: it sends the shell only the
// element's visible text and its box ("comment.pick"), never HTML. Pages need no code for this.
//
// Pages are single-page apps: navigating the frame to another origin is blocked (the shell's CSP frame-src), and a reload or
// a navigation within the content host loses the SDK connection. Use buttons and keyboard handlers, not <form> submission
// (the sandbox blocks form submission).
(() => {
  if (window.artifact) return;
  let port = null, status = "connecting", log = [], nextId = 1, readyResolve;
  const queue = [], msgCbs = new Set(), statusCbs = new Set(), pending = new Map();
  const post = (m) => (port ? port.postMessage(m) : queue.push(m));
  const setStatus = (s) => { status = s; statusCbs.forEach((cb) => cb(s)); };
  const deliver = (m) => {
    if (m.type === "history") log = m.messages.slice();
    else log.push(m);
    msgCbs.forEach((cb) => cb(m));
  };
  // ---- comment mode: frame the hovered element; a click sends its text and box to the shell ----
  let picking = false, box = null;
  const frameOf = (el) => {
    if (!box) {
      box = document.createElement("div");
      box.setAttribute("aria-hidden", "true");
      box.style.cssText = "position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #2563eb;border-radius:4px;background:rgba(37,99,235,.08);box-sizing:border-box";
    }
    if (!el) return box.remove();
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { left: `${r.left - 2}px`, top: `${r.top - 2}px`, width: `${r.width + 4}px`, height: `${r.height + 4}px` });
    document.documentElement.appendChild(box);
  };
  const target = (e) => (e.target instanceof Element && e.target !== document.documentElement && e.target !== document.body ? e.target : null);
  const onMove = (e) => frameOf(target(e));
  const onClick = (e) => {
    e.preventDefault(); e.stopImmediatePropagation();
    const el = target(e);
    if (!el) return;
    const r = el.getBoundingClientRect();
    const text = (el.innerText ?? el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
    post({ kind: "comment.pick", text, rect: { x: r.left, y: r.top, width: r.width, height: r.height } });
  };
  const block = (e) => { e.preventDefault(); e.stopImmediatePropagation(); }; // the page's own handlers must not act on the pick
  const setPicking = (on) => {
    if (on === picking) return;
    picking = on;
    const f = on ? addEventListener : removeEventListener;
    f("mousemove", onMove, true); f("click", onClick, true);
    for (const t of ["mousedown", "mouseup", "pointerdown", "pointerup", "dblclick"]) f(t, block, true);
    document.documentElement.style.cursor = on ? "crosshair" : "";
    if (!on) frameOf(null);
  };

  const api = {
    viewer: null,
    ready: new Promise((r) => (readyResolve = r)),
    room: {
      send(obj) {
        if (obj === null || typeof obj !== "object" || Array.isArray(obj)) throw new TypeError("room.send expects a JSON object");
        post({ kind: "room.send", msg: JSON.parse(JSON.stringify(obj)) });
      },
      onMessage(cb) {
        msgCbs.add(cb);
        if (port) cb({ type: "history", messages: log.slice() }); // late subscribers get the current state first
        return () => msgCbs.delete(cb);
      },
      onStatus(cb) { statusCbs.add(cb); cb(status); return () => statusCbs.delete(cb); },
    },
    tools: {
      call(name, args = {}) {
        const id = nextId++;
        return new Promise((resolve) => { pending.set(id, resolve); post({ kind: "tools.call", id, tool: String(name), args }); });
      },
    },
  };
  addEventListener("message", (e) => {
    if (port || e.source !== parent || e.data?.sdk !== "init" || !e.ports[0]) return;
    port = e.ports[0];
    api.viewer = e.data.viewer;
    port.onmessage = ({ data: m }) => {
      if (m.kind === "room.message") deliver(m.msg);
      else if (m.kind === "room.status") setStatus(m.status);
      else if (m.kind === "tools.result") { pending.get(m.id)?.(m.result); pending.delete(m.id); }
      else if (m.kind === "comment.mode") setPicking(m.on === true);
    };
    while (queue.length) port.postMessage(queue.shift());
    readyResolve(api);
  });
  window.artifact = api;
  parent.postMessage({ sdk: "hello", v: 1 }, "*"); // carries no data; the shell answers only its own iframe, with a private port
})();
