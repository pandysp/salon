// Shell restyle: one bar, Share and Comments as collapsed panels; no behaviour change.
// Chunk 3: consent dialog for viewer tools, connect prompt, approval bar and share warning for the owner.
// The shell: the trusted page on the app host. Renders home / sign-in / invite pages and the viewer page, which embeds the
// artifact (content host, sandboxed iframe), owns the room sockets and brokers everything the artifact may do through the
// SDK port (artifact-sdk.js). Boot data comes from the server in <script type="application/json" id="boot">.
import { createSignal, createMemo, For, Show } from "solid-js";
import { render } from "@solidjs/web";
import { startRegistration, startAuthentication } from "@simplewebauthn/browser";
import { connectRoom } from "./room-socket.js";
import { threads, agentItems } from "../worker/comments.js";

const boot = JSON.parse(document.getElementById("boot").textContent);
const K = new URLSearchParams(location.search).get("k"); // link token: sent with every request about this artifact
const withK = (p) => (K ? `${p}${p.includes("?") ? "&" : "?"}k=${encodeURIComponent(K)}` : p);
const api = async (path, body) => {
  const r = await fetch(path, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error ?? data.message ?? `HTTP ${r.status}`), { status: r.status, data });
  return data;
};

// Shell restyle: one slim top bar. The viewer page puts brand and account into
// its own bar (Viewer); the other pages get this one.
const Brand = () => <a href="/" class="brand" title="All artifacts">Artifacts</a>;
function Account() {
  const v = boot.viewer;
  const signOut = async () => { await api("/api/signout", {}); location.href = "/"; };
  return (
    <>
      <span class="who" data-testid="viewer">
        {v.kind === "owner" ? `${v.name} (owner)` : v.kind === "guest" ? v.name : boot.page === "viewer" ? "anonymous viewer (link)" : "not signed in"}
      </span>
      <Show when={v.kind === "guest"}><button type="button" class="ghost" data-testid="signout" onClick={signOut}>Sign out</button></Show>
      <Show when={v.kind === "public"}><a class="signin" href={`/signin?return=${encodeURIComponent(location.pathname)}`} data-testid="signin-link">Sign in</a></Show>
    </>
  );
}
function Header() {
  return <header class="top"><Brand /><span class="spacer" /><Account /></header>;
}

function Home() {
  const [items, setItems] = createSignal([]);
  if (boot.viewer.kind === "owner" || boot.viewer.kind === "guest") api("/api/artifacts").then(setItems);
  return (
    <main class="page">
      <h1>Artifacts</h1>
      <Show when={boot.viewer.kind === "owner" || boot.viewer.kind === "guest"} fallback={<p>Sign in with the passkey you created from an invite link.</p>}>
        <ul class="list" data-testid="artifact-list">
          <For each={items()}>{(a) => <li><a href={`/v/${a.name}`}>{a.name}</a> <small>v{a.version} · {a.sharing}</small></li>}</For>
        </ul>
      </Show>
    </main>
  );
}

function SignIn() {
  const [error, setError] = createSignal("");
  // only back to this origin: resolve `return` like the browser will, then compare origins (browsers read "/\host" as
  // "//host", so a prefix check is not enough; review F6)
  const back = () => {
    const u = URL.parse(new URLSearchParams(location.search).get("return") ?? "/", location.origin);
    location.href = u?.origin === location.origin ? u.href : "/";
  };
  const go = async () => {
    setError("");
    try {
      const { flow, options } = await api("/api/signin/options", {});
      await api("/api/signin/verify", { flow, response: await startAuthentication({ optionsJSON: options }) });
      back();
    } catch (e) { setError(e.message); }
  };
  const owner = async () => { setError(""); try { await api("/api/signin/owner", {}); back(); } catch (e) { setError(e.message); } };
  return (
    <main class="page narrow">
      <h1>Sign in</h1>
      <button type="button" data-testid="signin" onClick={go}>Sign in with passkey</button>
      <p class="hint">{boot.ownerName}, on a device in your tailnet: <button type="button" class="ghost" data-testid="signin-owner" onClick={owner}>Sign in as owner</button></p>
      <Show when={error()}><p class="error" data-testid="signin-error">{error()}</p></Show>
    </main>
  );
}

function Invite() {
  const [info, setInfo] = createSignal(null), [error, setError] = createSignal(""), [busy, setBusy] = createSignal(false);
  let nameInput;
  api(`/api/invites/${encodeURIComponent(boot.token)}`).then(setInfo, (e) => setError(e.message));
  const register = async () => {
    setBusy(true); setError("");
    try {
      const base = `/api/invites/${encodeURIComponent(boot.token)}`;
      if (boot.viewer.kind === "guest") { const r = await api(`${base}/accept`, {}); location.href = `/v/${r.artifact}`; return; }
      const { flow, options } = await api(`${base}/options`, {});
      const response = await startRegistration({ optionsJSON: options });
      const r = await api(`${base}/verify`, { flow, response, name: nameInput.value });
      location.href = `/v/${r.artifact}`;
    } catch (e) { setError(e.message); setBusy(false); }
  };
  return (
    <main class="page narrow">
      <h1>Invitation</h1>
      <Show when={info()} fallback={<Show when={error()} fallback={<p>Checking the invite…</p>}><p class="error" data-testid="invite-error">{error()}</p></Show>}>
        <p data-testid="invite-info">You were invited to <b>{info().artifact}</b>.</p>
        <Show when={boot.viewer.kind !== "guest"} fallback={<p>You are signed in as {boot.viewer.name}.</p>}>
          <label>Your name <input ref={(el) => { nameInput = el; el.value = info().label; }} data-testid="invite-name" /></label>
          <p class="hint">Your device creates a passkey for this site. Next time you sign in with it; no password.</p>
        </Show>
        <button type="button" data-testid="invite-accept" disabled={busy()} onClick={register}>
          {boot.viewer.kind === "guest" ? "Accept invite" : "Create passkey and open"}
        </button>
        <Show when={error()}><p class="error" data-testid="invite-error">{error()}</p></Show>
      </Show>
    </main>
  );
}

// ---------------- viewer page ----------------
function Viewer() {
  const [version, setVersion] = createSignal(null);
  // whether the app room takes this viewer's writes (/api/view roomWrite; R11)
  const [roomWrite, setRoomWrite] = createSignal(false);
  const [status, setStatus] = createSignal("connecting");
  // chunk 3: consent for viewer tools (per version), connect prompts, and (owner) the approval state
  const [consent, setConsent] = createSignal(null), [connectNeeded, setConnectNeeded] = createSignal(null), [approval, setApproval] = createSignal(null);
  let decided = null, decide = () => {}; // a promise viewer-tool calls wait on until the viewer answers the consent dialog
  let host, frame = null, port = null, log = [];

  // the app room: one socket per viewer, owned by the shell; the artifact only sees what the shell forwards
  const room = connectRoom(withK(`/api/rooms/${encodeURIComponent(boot.artifact)}/app`), {
    onStatus: (s) => {
      setStatus(s); port?.postMessage({ kind: "room.status", status: s });
      // live version swaps: a new version closes every room socket (Room.versionChanged), so a reconnect is the signal; it also
      // covers a dropped connection
      if (s === "connected" && version() !== null) loadVersion();
    },
    onMessage: (m) => {
      if (m.type === "history") log = m.messages.slice(); else log.push(m);
      port?.postMessage({ kind: "room.message", msg: m });
    },
  });

  const mount = (src) => {
    frame?.remove(); port?.close(); port = null;
    const f = document.createElement("iframe");
    f.setAttribute("sandbox", "allow-scripts allow-same-origin");
    f.setAttribute("referrerpolicy", "no-referrer");
    f.dataset.testid = "artifact-frame";
    f.src = src; // the frame cannot navigate to any other origin: this page's CSP has frame-src <content origin>
    frame = f;
    host.replaceChildren(f);
  };
  const loadVersion = async () => {
    const v = await api(withK(`/api/view/${encodeURIComponent(boot.artifact)}`));
    setApproval(v.approval ?? null);
    // a link visitor whose write right changed (the owner's link-write switch) reloads: the page gets the new viewer, and the /v/ GET
    // gives it its visitor cookie before the room socket opens (R11). Everyone else's write right changes only with the version
    // (DoD 6), and the mount below gives the page the new viewer
    if (version() !== null && !boot.canWrite && v.roomWrite !== roomWrite()) return location.reload();
    setRoomWrite(v.roomWrite);
    if (v.version === version()) return;
    setVersion(v.version);
    // a new version asks again (consent is per version); the frame's viewer-tool calls wait for the answer
    setConsent(v.consent);
    decided = !v.consent ? Promise.resolve(true) : !v.consent.needed ? Promise.resolve(true) : new Promise((r) => (decide = r));
    mount(v.src);
  };

  addEventListener("message", (e) => {
    if (!frame || e.source !== frame.contentWindow || e.origin !== boot.contentOrigin || e.data?.sdk !== "hello") return;
    port?.close();
    const ch = new MessageChannel();
    port = ch.port1;
    port.onmessage = ({ data: m }) => handle(m);
    // a link visitor (no grant) is kind "link" for the page, with no identity, so pages hide their inputs (R10).
    // canWrite: whether room.send reaches the room (R11: link visitors too while the owner lets them write; nobody on a personal version)
    const viewer = { ...(boot.canWrite ? boot.viewer : { kind: "link", id: null, name: null }), canWrite: roomWrite() };
    frame.contentWindow.postMessage({ sdk: "init", viewer }, boot.contentOrigin, [ch.port2]);
    port.postMessage({ kind: "room.status", status: status() });
    port.postMessage({ kind: "room.message", msg: { type: "history", messages: log.slice() } });
    if (commentMode()) port.postMessage({ kind: "comment.mode", on: true }); // a new version's frame stays in comment mode
  });

  // the closed list of what an artifact may ask for; anything else is dropped
  const handle = async (m) => {
    if (m?.kind === "room.send" && !roomWrite()) return console.warn("this viewer cannot write to the room: room.send dropped"); // the room refuses it too (R10, R11)
    if (m?.kind === "room.send" && m.msg && typeof m.msg === "object" && !Array.isArray(m.msg)) return room.send(m.msg);
    if (m?.kind === "tools.call" && Number.isInteger(m.id) && typeof m.tool === "string") {
      let result;
      const isViewerTool = consent()?.tools.some((t) => t.name === m.tool);
      if (isViewerTool && !(await decided)) result = { ok: false, error: "declined", message: "the viewer did not allow this page to use their accounts" };
      else {
        try { result = await api(withK(`/api/tools/${encodeURIComponent(boot.artifact)}/${encodeURIComponent(m.tool)}`), m.args ?? {}); }
        catch (e) { result = e.data && typeof e.data === "object" ? e.data : { ok: false, error: e.message }; }
        if (result.error === "not_connected") setConnectNeeded(result.server); // the shell offers the connect link; the artifact cannot open it
      }
      port?.postMessage({ kind: "tools.result", id: m.id, result });
      return;
    }
    if (m?.kind === "comment.pick") return pick(m);
    console.warn("artifact sent an unsupported message; dropped", m?.kind);
  };

  // comments: a second room, written only by this shell. Threads, pi's replies and the forward button ; the room checks every message (comments.js), so this UI is a convenience, not the guard.
  const [cmsgs, setCmsgs] = createSignal([]);
  let comments_room = null, commentInput;
  if (boot.canComment) comments_room = connectRoom(`/api/rooms/${encodeURIComponent(boot.artifact)}/comments`, {
    onStatus: () => {},
    onMessage: (m) => setCmsgs((l) => (m.type === "history" ? m.messages : [...l, m])),
  });
  const answer = async (yes) => {
    if (yes) await api(`/api/consent/${encodeURIComponent(boot.artifact)}`, { version: version() });
    setConsent((c) => ({ ...c, needed: false, declined: !yes }));
    decide(yes);
  };
  const connect = async (server) => {
    const r = await api(`/api/connect/${encodeURIComponent(server)}/start`, { return: location.pathname + location.search });
    location.href = r.authorize_url; // top-level navigation to the MCP server's sign-in page; it sends the browser back here
  };
  // "Send to agent": the owner may keep a comment from pi
  // (forPi: false); it can be forwarded later like a guest's. Guests have no box: theirs wait for the owner's forward anyway.
  let panelAgent, pinAgent;
  const sendComment = (text, agentBox) => comments_room.send({ type: "comment", id: crypto.randomUUID(), text,
    ...(version() !== null ? { version: version() } : {}), ...(agentBox && !agentBox.checked ? { forPi: false } : {}) });
  const addComment = () => {
    const text = commentInput.value.trim();
    if (!text) return;
    sendComment(text, panelAgent);
    commentInput.value = "";
  };
  // comment pins: the comment button switches the page into comment
  // mode (the SDK in the frame frames the hovered element); a click there sends only the element's text and box, and the shell
  // pins a composer at that spot. The quote goes into the comment text ("> quote\n\ncomment"), so the room, its rules and the
  // bridge stay as they are. No pins for old comments, no re-anchoring when the page changes.
  const [commentMode, setCommentMode] = createSignal(false), [pinned, setPinned] = createSignal(null);
  let stageEl, pinInput;
  const setMode = (on) => { setCommentMode(on); if (!on) setPinned(null); port?.postMessage({ kind: "comment.mode", on }); };
  const num = (v) => typeof v === "number" && Number.isFinite(v);
  const pick = (m) => {
    const r = m.rect;
    if (!commentMode() || typeof m.text !== "string" || !r || ![r.x, r.y, r.width, r.height].every(num)) return console.warn("comment.pick dropped");
    const f = host.getBoundingClientRect(), s = stageEl.getBoundingClientRect();
    const left = Math.max(8, Math.min(f.left - s.left + r.x, s.width - 328)), top = Math.max(8, Math.min(f.top - s.top + r.y + r.height + 6, s.height - 220));
    setPinned({ quote: m.text.replace(/\s+/g, " ").trim().slice(0, 300), left, top });
    queueMicrotask(() => pinInput?.focus());
  };
  const sendPinned = () => {
    const body = pinInput.value.trim(), q = pinned().quote;
    if (!body) return;
    sendComment(q ? `> ${q}\n\n${body}` : body, pinAgent);
    setMode(false); setCommentsOpen(true); setShareOpen(false);
  };
  const forPi = createMemo(() => new Set(agentItems(cmsgs()).map((t) => t.id))); // exactly what pi gets (the gate itself)
  const forward = (id) => comments_room.send({ type: "forward", comment: id });
  const who = (from) => (from === "owner" ? boot.ownerName : from === "agent" ? "pi" : from);

  // shell restyle: Share (owner panel) and Comments are collapsed by default; both stay mounted and are only hidden
  const [shareOpen, setShareOpen] = createSignal(false), [commentsOpen, setCommentsOpen] = createSignal(false);
  // comment states: resolved threads fold away behind one toggle,
  // like Claude Artifacts; they stay mounted (hidden), so their live state still updates
  const [showResolved, setShowResolved] = createSignal(false);
  // comments filter: "Show resolved" lives in a small filter menu like
  // Claude's 'All comments' card. No "all pages" scope: no route lists comments across pages (only the per-artifact comments room)
  let filterEl;
  const [filterOpen, setFilterOpen] = createSignal(false);
  addEventListener("pointerdown", (e) => filterOpen() && !filterEl?.contains(e.target) && setFilterOpen(false));
  const all = createMemo(() => threads(cmsgs()));
  const resolvedCount = () => all().filter((t) => t.resolved).length;
  const Thread = (t) => (
    <li class="thread" data-testid="thread" data-id={t.id} data-resolved={String(t.resolved)} data-for-pi={String(forPi().has(t.id))}>
      <span data-testid="comment"><b>{who(t.from)}</b> {t.text}</span>
      <span class="meta">
        {t.version !== null ? `v${t.version} ` : ""}
        <Show when={forPi().has(t.id)}><span class="badge">for pi</span></Show>
        <Show when={t.resolved}><span class="badge done" data-testid="thread-resolved">resolved</span></Show>
        <Show when={boot.viewer.kind === "owner" && !forPi().has(t.id)}>
          <button type="button" class="ghost small" data-testid="comment-forward" onClick={() => forward(t.id)}>Forward to pi</button>
        </Show>
      </span>
      <For each={t.replies}>{(r) => <p class="reply" data-testid="thread-reply"><b>{who(r.from)}</b> {r.text}</p>}</For>
      {/* pi has the thread (the owner's own, or forwarded) and has neither replied nor resolved it yet */}
      <Show when={forPi().has(t.id) && !t.resolved && !t.replies.some((r) => r.from === "agent")}>
        <p class="working" data-testid="thread-working" role="status"><span class="dot" aria-hidden="true" />pi is working…</p>
      </Show>
    </li>
  );

  return (
    <main class="viewer">
      <header class="bar">
        <Brand /><span class="sep" aria-hidden="true">/</span>
        <h1 data-testid="artifact-title" title={boot.title}>{boot.title}</h1>
        <span data-testid="artifact-version" hidden>{version() === null ? "" : `v${version()}`}</span>{/* badge dropped; kept hidden because tests read it. */}
        <span class="status" data-testid="room-status" data-status={status()} title={`live: ${status()}`}><span class="sr">{status()}</span></span>
        <span class="spacer" />
        <Account />
        <Show when={boot.viewer.kind === "owner"}>
          <button type="button" class="toggle primary" data-testid="share-toggle" aria-expanded={String(shareOpen())} aria-controls="share-panel"
            data-attention={approval()?.waiting ? "approval" : undefined} title={approval()?.waiting ? "A version waits for your approval" : undefined}
            onClick={() => { setShareOpen(!shareOpen()); setCommentsOpen(false); }}>{lock()}Share</button>
        </Show>
        <Show when={boot.canComment}>
          <button type="button" class="toggle icon" data-testid="comment-mode" aria-pressed={String(commentMode())} title={commentMode() ? "Leave comment mode" : "Comment on an element of the page"}
            onClick={() => setMode(!commentMode())}><span aria-hidden="true">💬</span><span class="sr">Comment mode</span></button>
          <button type="button" class="toggle" data-testid="comments-toggle" aria-expanded={String(commentsOpen())} aria-controls="comments-panel"
            onClick={() => { setCommentsOpen(!commentsOpen()); setShareOpen(false); }}>Comments</button>
        </Show>
        <Show when={boot.viewer.kind === "owner"}>
          <OwnerPanel open={shareOpen()}>
            <Show when={approval()?.waiting}>
              <div class="notice" data-testid="approval">
                v{approval().waiting.version} waits for your approval. Guests see {approval().guestsSee ? `v${approval().guestsSee}` : "nothing yet"}.
                Its tools: {approval().waiting.tools.map((t) => `${t.server}/${t.name} (${t.binding}${t.binding === "owner" ? " " + JSON.stringify(t.args) : ""})`).join(", ") || "none"}
                <button type="button" data-testid="approve" onClick={async () => { await api(`/api/artifacts/${encodeURIComponent(boot.artifact)}/versions/${approval().waiting.version}/approve`, {}); await loadVersion(); }}>Approve for guests</button>
              </div>
            </Show>
          </OwnerPanel>
        </Show>
      </header>
      <Show when={connectNeeded()}>
        <div class="notice" data-testid="connect-needed">
          This page shows your own data from <b>{connectNeeded()}</b>. <button type="button" data-testid="connect" onClick={() => connect(connectNeeded())}>Connect {connectNeeded()}</button>
        </div>
      </Show>
      <Show when={consent()?.declined}><div class="notice" data-testid="consent-declined">You chose not to share your data with this page. Reload to decide again.</div></Show>
      <div class="stage" ref={(el) => (stageEl = el)} data-comment-mode={commentMode() ? "on" : undefined}>
        <Show when={pinned()}>
          <div class="pin" data-testid="comment-pin" role="dialog" aria-label="Comment on this element" style={{ left: `${pinned().left}px`, top: `${pinned().top}px` }}>
            <Show when={pinned().quote}><blockquote data-testid="comment-pin-quote">{pinned().quote}</blockquote></Show>
            <textarea ref={(el) => (pinInput = el)} data-testid="comment-pin-input" placeholder="Add a comment"
              onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && sendPinned()} />
            <div class="row">
              {/* the owner's comments reach pi unless they untick the box (agentItems); guests' reach pi only when the owner forwards them */}
              <Show when={boot.viewer.kind === "owner"} fallback={<span class="hint">{boot.ownerName} decides what goes to pi</span>}>
                <label class="check hint" title="Untick to keep this comment from pi; you can forward it later"><input type="checkbox" ref={(el) => (pinAgent = el)} data-testid="comment-pin-agent" checked /> Send to agent</label>
              </Show>
              <span class="spacer" />
              <button type="button" class="ghost" onClick={() => setPinned(null)}>Cancel</button>
              <button type="button" data-testid="comment-pin-send" onClick={sendPinned}>Comment</button>
            </div>
          </div>
        </Show>
        <Show when={consent()?.needed}>
          <div class="consent" data-testid="consent" role="dialog" aria-label="Allow this page to use your accounts?">
            <h2>Allow this page to read your data?</h2>
            <p>This page (v{version()}) wants to call these tools <b>with your own accounts</b>, read-only:</p>
            <ul><For each={consent().tools}>{(t) => <li><code>{t.name}</code> on <b>{t.server}</b></li>}</For></ul>
            <p class="hint">The page never sees your sign-in. You can say no; it then shows without your data.</p>
            <button type="button" data-testid="consent-allow" onClick={() => answer(true)}>Allow</button>{" "}
            <button type="button" class="ghost" data-testid="consent-decline" onClick={() => answer(false)}>Not now</button>
          </div>
        </Show>
        <div class="frame" ref={(el) => { host = el; queueMicrotask(loadVersion); }} />
        <Show when={boot.canComment}>
          <aside class="comments panel" id="comments-panel" data-testid="comments" hidden={!commentsOpen()}>
            <div class="head">
              <h2>Comments</h2>
              <div class="filter" ref={(el) => (filterEl = el)} onKeyDown={(e) => e.key === "Escape" && setFilterOpen(false)}>
                <button type="button" class="ghost icon" data-testid="comments-filter" title="Filter comments" aria-haspopup="menu" aria-expanded={String(filterOpen())}
                  onClick={() => setFilterOpen(!filterOpen())}>
                  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M2 4h12M4.5 8h7M7 12h2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
                  <span class="sr">Filter comments</span>
                </button>
                <div class="menu" role="menu" data-testid="comments-filter-menu" hidden={!filterOpen()}>
                  <button type="button" role="menuitemcheckbox" data-testid="comments-show-resolved" aria-checked={String(showResolved())} aria-controls="comments-resolved"
                    onClick={() => setShowResolved(!showResolved())}><span class="tick" aria-hidden="true">{showResolved() ? "✓" : ""}</span>Show resolved ({resolvedCount()})</button>
                </div>
              </div>
            </div>
            <div class="threads">
              <ul><For each={all().filter((t) => !t.resolved)}>{Thread}</For></ul>
              <ul id="comments-resolved" class="resolved" data-testid="comments-resolved" hidden={!showResolved()}><For each={all().filter((t) => t.resolved)}>{Thread}</For></ul>
            </div>
            <textarea ref={(el) => (commentInput = el)} data-testid="comment-input" placeholder="Comment on this page" />
            <Show when={boot.viewer.kind === "owner"}>
              <label class="check hint" title="Untick to keep this comment from pi; you can forward it later"><input type="checkbox" ref={(el) => (panelAgent = el)} data-testid="comment-agent" checked /> Send to agent</label>
            </Show>
            <button type="button" data-testid="comment-send" onClick={addComment}>Comment</button>
          </aside>
        </Show>
      </div>
    </main>
  );
}

// share popover like Claude Artifacts: lock on Share; title, invite,
// people with access (the owner only: the shell holds no guest list), general access + link-write, footer with Copy link
const lock = () => <svg class="lock" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1.6" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></svg>;
const ACCESS = { private: "Only you can open this page", invited: "Only you and invited guests can open this page", link: "Anyone with the link can open this page" };
function OwnerPanel(props) {
  const [sharing, setSharing] = createSignal(boot.sharing), [invite, setInvite] = createSignal(""), [error, setError] = createSignal("");
  const [link, setLink] = createSignal(""), [warning, setWarning] = createSignal(""), [linkWrite, setLinkWrite] = createSignal(false);
  let label;
  const base = `/api/artifacts/${encodeURIComponent(boot.artifact)}`;
  const share = async (mode) => { try { const r = await api(`${base}/sharing`, { mode }); setSharing(r.sharing); setLink(r.url ?? ""); setWarning(r.warning ?? ""); setLinkWrite(r.link_write); } catch (e) { setError(e.message); } };
  api(base).then((d) => { setLink(d.link ?? ""); setLinkWrite(d.link_write); }, (e) => setError(e.message)); // the live link, to copy again (R2); share warning (T8) above
  // R11: The owner lets link visitors write to the room (e.g. vote); off by default
  const toggleLinkWrite = async (on) => { setError(""); try { setLinkWrite((await api(`${base}/link-write`, { on })).link_write); } catch (e) { setError(e.message); setLinkWrite(!on); } };
  const [copied, setCopied] = createSignal(false);
  let copiedTimer;
  const copyLink = async () => { setError(""); try { await navigator.clipboard.writeText(link()); setCopied(true); clearTimeout(copiedTimer); copiedTimer = setTimeout(() => setCopied(false), 2000); } catch (e) { setError(`Copy failed: ${e.message}`); } };
  const makeInvite = async () => { try { setInvite((await api(`${base}/invites`, { label: label.value })).url); } catch (e) { setError(e.message); } };
  return (
    <div class="owner share panel" id="share-panel" role="dialog" aria-label="Share" hidden={!props.open}>
      <h2 title={boot.title}>{boot.title}</h2>
      {props.children}
      <div class="row">
        <input ref={(el) => (label = el)} data-testid="invite-label" placeholder="Invite a guest by name" />
        <button type="button" data-testid="invite-create" onClick={makeInvite}>Invite</button>
      </div>
      <Show when={invite()}><input readonly class="invite-url" data-testid="invite-url" value={invite()} title="Invite link: send it to the guest" /></Show>
      <section>
        <span class="field">People with access</span>
        <div class="person">
          <span class="avatar" aria-hidden="true">{boot.viewer.name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase()}</span>
          <span class="name">{boot.viewer.name} <span class="hint">(you)</span></span>
          <span class="role">Owner</span>
        </div>
      </section>
      <section>
        <span class="field">General access</span>
        <div class="person">
          <span class="avatar icon">{lock()}</span>
          <select data-testid="sharing" aria-label="General access" value={sharing()} onChange={(e) => share(e.currentTarget.value)}>
            <option value="private">Only you</option><option value="invited">Invited guests</option><option value="link">Anyone with the link</option>
          </select>
        </div>
        <label class="check hint" title="Visitors with the link can then send to the page's room (e.g. vote). They still cannot comment or use tools. Only with sharing 'anyone with the link'.">
          <input type="checkbox" data-testid="link-write" checked={linkWrite()} disabled={sharing() !== "link"} onChange={(e) => toggleLinkWrite(e.currentTarget.checked)} />
          {" "}link visitors may write to the room{sharing() === "link" ? "" : " (only with 'anyone with the link')"}
        </label>
        <Show when={link()}><input readonly class="invite-url" data-testid="link-url" value={link()} /></Show>
        <Show when={warning()}><p class="warning" data-testid="share-warning">⚠️ {warning()}</p></Show>
      </section>
      <Show when={error()}><p class="error">{error()}</p></Show>
      <footer>
        <span class="hint">{ACCESS[sharing()]}</span>
        <Show when={link()}>{/* Copy link */}
          <button type="button" onClick={copyLink}>{copied() ? "Copied" : "Copy link"}</button>
        </Show>
      </footer>
    </div>
  );
}

const pages = {
  home: Home, signin: SignIn, invite: Invite, viewer: Viewer,
  noaccess: () => <main class="page narrow"><h1 data-testid="noaccess">Not found</h1><p>This page does not exist, or you have no access to it.</p></main>,
  notfound: () => <main class="page narrow"><h1>Not found</h1></main>,
};
const Page = pages[boot.page];
render(() => <>{boot.page === "viewer" ? null : <Header />}<Page /></>, document.getElementById("root")); // the viewer page has its own bar (shell restyle)
