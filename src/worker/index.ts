// Chunk 3: the tool route runs the MCP call; consent, connect start/callback, approve routes; /api/view carries consent + approval.
// The one platform Worker. Routes by Host: APP_ORIGIN (shell pages, sign-in, APIs, rooms) vs CONTENT_ORIGIN (artifact files
// only).
// Security model: docs/ARCHITECTURE.md. Short version:
//  - every request is authorised by a session cookie (__Host-session: owner or guest) or the agent's bearer token - never by
//    the tailnet header; a link viewer has no identity, only the link token, and views only: its room socket is read-only
//    (spec; R10);
//  - the tailnet header (allowlisted Tailscale-User-Login, no Funnel marker) counts only at POST /api/signin/owner, which
//    mints the owner session (Tailscale attaches the header to every request from the owner's devices, so honouring it anywhere
//    else would let any page he opens act as him);
//  - every browser write (non-GET, WebSocket) must come from APP_ORIGIN (the two hosts are the same site in production, so
//    SameSite never protects anything here);
//  - the content host never looks at identity; it serves files only for a valid content capability of the current version.
import { UserError, b64u, rand, ownerName, type Manifest } from "./platform";
import { mcp } from "./mcp";
import { readJson } from "./body"; // every body is read through it: size cap (pre-Funnel review B1)
export { Platform } from "./platform";
export { Room } from "./room.js";

declare const __SHELL_JS__: string, __SHELL_CSS__: string, __SDK_JS__: string;

// MCP_SERVERS: The owner's MCP server config (JSON, see tools.ts); TOKEN_KEY: AES key for stored OAuth tokens (from a secret file)
// OWNER_NAME: the owner's display name (ownerName in platform.ts, default "Owner")
type Env = { APP_ORIGIN: string; CONTENT_ORIGIN: string; OWNER_LOGINS: string; OWNER_NAME?: string; AGENT_TOKEN: string; MCP_SERVERS: string; TOKEN_KEY: string; PLATFORM: any; ROOM: any };
export type Viewer =
  | { kind: "owner"; id: "owner"; name: string }
  | { kind: "agent"; id: "agent"; name: "pi" }
  | { kind: "guest"; id: string; name: string; guestId: string }
  | { kind: "public"; id: null; name: null };

const P = (env: Env) => env.PLATFORM.getByName("main");
const COMMON = { "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" }; // on every response of both hosts
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { ...COMMON, "content-type": "application/json", "cache-control": "no-store", ...headers } });
// strict: browsers separate cookies with "; ". A looser \s* would read "<U+00A0>__Host-session" (a cookie any page on the shared
// parent domain may set) as the session cookie (core review, F5's first fix)
const cookieOf = (req: Request, name: string) =>
  new RegExp(`(?:^|; ?)${name.replace(/[$]/g, "\\$")}=([^;]+)`).exec(req.headers.get("cookie") ?? "")?.[1] ?? null;
const setCookie = (name: string, value: string, maxAge: number) =>
  `${name}=${value}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`; // host-only (no Domain), __Host- prefix enforces it

// the tailnet owner: allowlisted login, and not Funnel traffic (tailscale serve deletes client-sent copies of both headers
// and sets the marker on public requests; the marker check is defence in depth)
function tailnetOwner(req: Request, env: Env) {
  const login = req.headers.get("tailscale-user-login");
  const owners = env.OWNER_LOGINS.split(",").map((s) => s.trim()).filter(Boolean);
  return !!login && !req.headers.has("tailscale-funnel-request") && owners.includes(login);
}
const sha = async (s: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
async function sameSecret(a: string, b: string) { // compare digests, not the secrets, so timing says nothing about b
  const [x, y] = [await sha(a), await sha(b)];
  return x.every((v, i) => v === y[i]);
}

// The one place that decides who is asking. Owner and agent exist only on tailnet traffic (spec: owner actions need the
// tailnet): on Funnel traffic the agent token is refused and an owner session counts as not signed in, for every route,
// room and read alike (review F2).
async function identify(req: Request, env: Env): Promise<Viewer> {
  const funnel = req.headers.has("tailscale-funnel-request");
  const auth = req.headers.get("authorization");
  if (auth !== null) {
    const m = /^Bearer (.+)$/.exec(auth);
    if (!m || !env.AGENT_TOKEN || !(await sameSecret(m[1], env.AGENT_TOKEN))) throw new UserError(401, "invalid bearer token");
    // pi runs on the tailnet; the token is refused on public (Funnel) traffic, so a leaked token reads and writes nothing
    if (funnel) throw new UserError(403, "the agent token works only from the tailnet");
    return { kind: "agent", id: "agent", name: "pi" };
  }
  const sid = cookieOf(req, "__Host-session");
  if (sid) {
    const s = await P(env).session(sid);
    if (s?.subject === "owner") return funnel ? PUBLIC : { kind: "owner", id: "owner", name: ownerName(env) };
    if (s) return { kind: "guest", id: s.subject, name: s.name!, guestId: s.subject.slice(2) };
  }
  return PUBLIC;
}
const PUBLIC: Viewer = { kind: "public", id: null, name: null };

// A browser always sends Origin on cross-origin writes and WebSocket handshakes. Missing Origin = a non-browser client
// (curl, pi on a tailnet device), which cannot ride a browser's ambient identity.
function foreignOrigin(req: Request, env: Env) {
  const origin = req.headers.get("origin"), site = req.headers.get("sec-fetch-site");
  if (origin !== null && origin !== env.APP_ORIGIN) return `origin ${origin}`;
  if (site !== null && site !== "same-origin" && site !== "none") return `sec-fetch-site ${site}`;
  return null;
}

const CONTENT_CSP = (env: Env) =>
  `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; ` +
  `frame-ancestors ${env.APP_ORIGIN}; form-action 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; manifest-src 'none'`;
const APP_CSP = (env: Env) =>
  `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; ` +
  `frame-src ${env.CONTENT_ORIGIN}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'`;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    try {
      // Compare hosts, not origins: tailscale serve terminates TLS and proxies plain http to celld (serve.go keeps Host and sets
      // X-Forwarded-Proto), so req.url says http:// while the configured origins say https://.
      if (url.host === new URL(env.CONTENT_ORIGIN).host) return await content(req, env, url);
      if (url.host === new URL(env.APP_ORIGIN).host) return await app(req, env, url);
      return new Response(`unknown host ${url.host}`, { status: 421, headers: COMMON });
    } catch (e: any) {
      if (e instanceof UserError || e?.status) return json({ error: e.message }, e.status ?? 400);
      console.log(`error ${req.method} ${url.pathname}: ${e?.stack ?? e}`);
      return json({ error: "internal error" }, 500);
    }
  },
};

// ---------------- content host: artifact files only ----------------
// the one Sec-Fetch-Dest each document type may be fetched for: HTML only as the shell's frame, SVG only as an image (where it
// runs no script; opened top-level an SVG runs scripts like a page: tests/review.spec.mjs F8). Every other type is inert text.
const DOCUMENT_DEST: Record<string, string> = { "text/html": "iframe", "image/svg+xml": "image" };
async function content(req: Request, env: Env, url: URL) {
  const headers = { ...COMMON, "content-security-policy": CONTENT_CSP(env) };
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed", { status: 405, headers });
  if (url.pathname === "/_sdk/artifact-sdk.js")
    return new Response(__SDK_JS__, { headers: { ...headers, "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" } });
  const m = /^\/c\/([^/]+)\/(.+)$/.exec(url.pathname);
  if (!m) return new Response("not found", { status: 404, headers });
  const f = await P(env).readContent(decodeURIComponent(m[1]), decodeURIComponent(m[2]));
  if (!f) return new Response("not found or link expired", { status: 404, headers });
  // types that render as documents are served only for their one use: opened top-level (a forwarded link, "open frame in new
  // tab") they would run without the sandbox and the shell's frame-src (review F8)
  const dest = DOCUMENT_DEST[f.contentType.split(";")[0]];
  if (dest && req.headers.get("sec-fetch-dest") !== dest) return new Response("Open this page through its viewer link.", { status: 403, headers });
  return new Response(f.body, { headers: { ...headers, "content-type": f.contentType, "cache-control": "private, max-age=3600" } });
}

// ---------------- app host ----------------
async function app(req: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname, method = req.method;
  const isWs = req.headers.get("upgrade")?.toLowerCase() === "websocket";
  if (method !== "GET" && method !== "HEAD" || isWs) {
    const bad = foreignOrigin(req, env);
    if (bad) {
      console.log(`refused cross-origin ${method} ${path}: ${bad}`);
      return json({ error: "cross-origin request refused" }, 403);
    }
  }
  if (path === "/assets/shell.js") return new Response(__SHELL_JS__, { headers: { ...COMMON, "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" } });
  if (path === "/assets/shell.css") return new Response(__SHELL_CSS__, { headers: { ...COMMON, "content-type": "text/css; charset=utf-8", "cache-control": "no-cache" } });
  if (path === "/favicon.ico") return new Response(null, { status: 204, headers: COMMON });

  const viewer = await identify(req, env);
  const platform = P(env);
  const k = url.searchParams.get("k"); // link token (sharing "link")
  // owner and agent exist only on tailnet traffic (identify), so this also keeps their actions off the public internet
  const need = (...kinds: string[]) => { if (!kinds.includes(viewer.kind)) throw new UserError(403, `${kinds.join(" or ")} only`); };
  const body = () => readJson(req);
  let seg = path.split("/").slice(1).map(decodeURIComponent);

  // ---- pages (all rendered by the shell bundle; the server only decides access and boot data) ----
  if (method === "GET" && !path.startsWith("/api/")) {
    if (path === "/") return page(env, { page: "home", viewer: pub(viewer) });
    if (path === "/signin") return page(env, { page: "signin", viewer: pub(viewer) });
    if (seg[0] === "invite" && seg[1]) return page(env, { page: "invite", viewer: pub(viewer), token: seg[1] });
    if (seg[0] === "v" && seg[1]) {
      const acc = await platform.access(seg[1], viewer, k);
      if (!acc) return page(env, { page: "noaccess", viewer: pub(viewer), artifact: seg[1] }, 404);
      return page(env, { // the shell fetches the version + content URL from /api/view (one code path for first load and swaps)
        page: "viewer", viewer: pub(viewer), artifact: acc.name, sharing: acc.sharing, title: acc.manifest.title ?? acc.name,
        canComment: acc.comment, canWrite: acc.write, contentOrigin: env.CONTENT_ORIGIN,
      }, 200, visitorCookie(req, acc));
    }
    return page(env, { page: "notfound", viewer: pub(viewer) }, 404);
  }

  // ---- API ----
  if (seg[0] !== "api") return json({ error: "not found" }, 404);
  seg = seg.slice(1);
  const r = `${method} /${seg[0] ?? ""}`;

  if (r === "GET /me") return json(pub(viewer));


  // owner sign-in: the only place the tailnet header counts. Browser only (Origin must be the app), so a foreign page can
  // neither mint nor use the owner session.
  if (r === "POST /signin" && seg[1] === "owner") {
    if (req.headers.get("origin") !== env.APP_ORIGIN) throw new UserError(403, "owner sign-in needs the app origin");
    if (!tailnetOwner(req, env)) throw new UserError(403, `Owner sign-in works only from ${ownerName(env)}'s tailnet.`);
    const s = await platform.ownerSession();
    return json({ ok: true }, 200, { "set-cookie": setCookie("__Host-session", s.token, s.maxAge) });
  }

  // passkeys + invites
  if (seg[0] === "invites" && seg[1]) {
    const token = seg[1];
    if (method === "GET" && seg.length === 2) return json(await platform.inviteInfo(token));
    if (method === "POST" && seg[2] === "options") return json(await platform.registerOptions(token));
    if (method === "POST" && seg[2] === "verify") {
      const b = await body();
      const res = await platform.registerVerify(token, b.flow, b.response, b.name);
      return json({ artifact: res.artifact }, 200, { "set-cookie": setCookie("__Host-session", res.session.token, res.session.maxAge) });
    }
    if (method === "POST" && seg[2] === "accept") {
      if (viewer.kind !== "guest") throw new UserError(401, "sign in first");
      return json(await platform.acceptInvite(token, viewer.guestId));
    }
  }
  if (r === "POST /signin" && seg[1] === "options") return json(await platform.signinOptions());
  if (r === "POST /signin" && seg[1] === "verify") {
    const b = await body();
    const res = await platform.signinVerify(b.flow, b.response);
    return json({ ok: true }, 200, { "set-cookie": setCookie("__Host-session", res.session.token, res.session.maxAge) });
  }
  if (r === "POST /signout") {
    const sid = cookieOf(req, "__Host-session");
    if (sid) await platform.endSession(sid);
    return json({ ok: true }, 200, { "set-cookie": setCookie("__Host-session", "", 0) });
  }

  // pi's authoring MCP endpoint (src/worker/mcp.ts): agent bearer only, tailnet only
  if (seg[0] === "mcp" && seg.length === 1) { need("agent"); return mcp(req, env); }

  // artifacts
  if (seg[0] === "artifacts") {
    const name = seg[1], action = seg[2];
    if (method === "GET" && !name) return json(await platform.listFor(viewer));
    need("owner", "agent"); // pi (agent) may read and publish; everything else below is the owner's
    if (method === "GET" && name && !action) {
      const d = await platform.details(name);
      // the owner (an owner session, so on the tailnet) can copy the live link again without ending it; the agent never sees it
      // (review F3, R2; lead's decision)
      return json(viewer.kind === "owner" ? { ...d, link: linkUrl(env, name, await platform.link(name)) } : d);
    }
    // (`!seg[3]`: …/versions/<v>/approve is the owner's, below)
    if (method === "POST" && action === "versions" && !seg[3]) { const b = await body(); return json(await platform.publish(name, b.manifest, b.files, viewer.id!)); }
    need("owner");
    // the approval gate (chunk 3): The owner approves a waiting version, then guests get it
    if (method === "POST" && action === "versions" && seg[3] && seg[4] === "approve") return json(await platform.approve(name, Number(seg[3])));
    // "link visitors may write to the room" (R11): owner-only like sharing (need above: an owner session, so on the tailnet)
    if (method === "POST" && action === "link-write") { const b = await body(); return json(await platform.setLinkWrite(name, b.on)); }
    if (method === "POST" && action === "rollback") { const b = await body(); return json(await platform.rollback(name, b.version)); }
    if (method === "POST" && action === "sharing") {
      const b = await body(), s = await platform.setSharing(name, b.mode);
      // the share warning (T8) next to the live link (R2)
      return json({ sharing: s.sharing, warning: s.warning, link_write: s.link_write, ...(s.link_token ? { url: linkUrl(env, name, s.link_token) } : {}) });
    }
    if (method === "POST" && action === "invites") {
      const b = await body();
      const { token } = await platform.createInvite(name, b.label);
      return json({ url: `${env.APP_ORIGIN}/invite/${token}` });
    }
    if (method === "GET" && action === "archive") return json(await env.ROOM.getByName("app:" + name).archived());
  }

  // rooms: /api/rooms/<artifact>/app|comments (WebSocket). Comments: only the shell writes them (artifacts have no route to
  // this origin: CSP connect-src 'none' on the content host, and the Origin check above).
  if (r === "GET /rooms" && seg[1] && (seg[2] === "app" || seg[2] === "comments")) {
    if (!isWs) return json({ error: "WebSocket expected" }, 426);
    const acc = await platform.access(seg[1], viewer, k);
    if (!acc || (seg[2] === "comments" && !acc.comment)) return json({ error: "no access" }, 404);
    const headers = new Headers(req.headers);
    // who writes; a link visitor (acc.write false) gets no `from`, which makes its socket read-only in the room. A
    // client-sent copy of the header is always dropped (R10)
    headers.delete("x-room-from");
    // personal or shared (DoD 6): no app-room writes for a version with viewer tools (`personal`, below). roomWrite: `write`, or a link visitor while the owner lets them write (R11); comments rooms keep asking `write` (access() above
    // already refused visitors there: no `comment`)
    const writes = seg[2] === "app" ? acc.roomWrite && !personal(acc.manifest) : acc.write;
    if (writes) headers.set("x-room-from", acc.write ? viewer.id! : await visitorFrom(req));
    headers.set("x-room-kind", seg[2]); // comments rooms check every message and gate what pi sees (comments.js)
    return env.ROOM.getByName(`${seg[2]}:${acc.name}`).fetch(new Request(req.url, { headers }));
  }

  // the current version of an artifact the viewer may see (the shell re-reads it on every room reconnect; a new version closes the room's sockets)
  if (r === "GET /view" && seg[1]) {
    const acc = await platform.access(seg[1], viewer, k);
    if (!acc) return json({ error: "no access" }, 404);
    const cap = await platform.contentCap(acc.name, acc.version);
    const vt = ((acc.manifest as Manifest).tools ?? []).filter((t) => t.binding === "viewer");
    return json({
      version: acc.version, src: `${env.CONTENT_ORIGIN}/c/${encodeURIComponent(cap)}/index.html`,
      roomWrite: acc.roomWrite && !personal(acc.manifest), // the page's artifact.viewer.canWrite (R11): what the room will accept
      // viewer tools need this viewer's yes for this version (asked by the shell before the first call)
      consent: acc.write && vt.length ? { needed: !(await platform.hasConsent(viewer.id, acc.name, acc.version)), tools: vt.map((t) => ({ name: t.name, server: t.server })) } : null,
      ...(viewer.kind === "owner" ? { approval: await platform.approval(acc.name) } : {}),
    });
  }

  // consent to the viewer tools of the version this viewer sees (a "no" is never stored: the shell keeps it for the page)
  if (r === "POST /consent" && seg[1]) {
    if (viewer.kind !== "owner" && viewer.kind !== "guest") throw new UserError(401, "sign in first");
    const acc = await platform.access(seg[1], viewer, null);
    if (!acc || !acc.write) return json({ error: "no access" }, 404);
    const b = await body();
    if (b.version !== acc.version) throw new UserError(409, "the page changed; reload and decide again");
    return json(await platform.consent(viewer.id, acc.name, acc.version));
  }

  // MCP connections (OAuth). Start: a POST from the shell (state changes never happen on a plain GET from a foreign page)...
  if (r === "POST /connect" && seg[1] && seg[2] === "start") {
    if (viewer.kind !== "owner" && viewer.kind !== "guest") throw new UserError(401, "sign in first");
    const b = await body(), back = typeof b.return === "string" && b.return.startsWith("/") && !b.return.startsWith("//") ? b.return : "/";
    return json(await platform.connectStart(viewer.id, seg[1], back));
  }
  // ...callback: the authorization server sends the browser here (a top-level GET, the one GET with an effect). It only finishes
  // a flow this same signed-in viewer started (state is bound to the subject); a foreign page cannot complete it for them.
  if (r === "GET /connect" && seg[1] === "callback") {
    if (viewer.kind !== "owner" && viewer.kind !== "guest") throw new UserError(401, "sign in first");
    const state = url.searchParams.get("state"), code = url.searchParams.get("code");
    if (!state || !code) throw new UserError(400, `authorization was not granted (${url.searchParams.get("error") ?? "no code"})`);
    const { returnTo } = await platform.connectFinish(viewer.id, state, code);
    return new Response(null, { status: 303, headers: { ...COMMON, location: returnTo, "cache-control": "no-store" } });
  }

  // tool calls from the shell: access, manifest, binding, pinned args, consent here; the MCP call itself in Platform.callTool
  if (method === "POST" && seg[0] === "tools" && seg[1] && seg[2]) {
    const acc = await platform.access(seg[1], viewer, k);
    if (!acc) return json({ ok: false, error: "no access" }, 404);
    const tool = (acc.manifest as Manifest).tools?.find((t) => t.name === seg[2]);
    if (!acc.write) return json({ ok: false, error: "view_only", message: "link visitors view only" }, 403); // R10
    if (!tool) {
      await platform.event("tool-denied", acc.name, viewer.id, { tool: seg[2], reason: "not in manifest" });
      return json({ ok: false, error: "not_declared", message: `tool "${seg[2]}" is not declared in this artifact's manifest` }, 403);
    }
    const args = await body();
    if (args === null || typeof args !== "object" || Array.isArray(args)) return json({ ok: false, error: "bad_args", message: "arguments must be a JSON object" }, 400);
    if (tool.binding === "owner" && Object.keys(args ?? {}).length > 0) { // owner tools run their pinned args only
      await platform.event("tool-denied", acc.name, viewer.id, { tool: tool.name, reason: "client args for an owner tool" });
      return json({ ok: false, error: "args_pinned", message: "owner tools take no arguments from the page" }, 403);
    }
    if (tool.binding === "viewer" && !(await platform.hasConsent(viewer.id, acc.name, acc.version)))
      return json({ ok: false, error: "consent_required", message: "the viewer has not agreed to this page's tools yet" }, 403);
    // owner tools run on the owner's account with the pinned arguments; viewer tools on the signed-in viewer's own account
    const res = tool.binding === "owner"
      ? await platform.callTool(acc.name, tool, tool.args ?? {}, "owner", viewer.id!)
      : await platform.callTool(acc.name, tool, args, viewer.id, viewer.id);
    return json(res, res.ok ? 200 : TOOL_STATUS[res.error] ?? 502);
  }

  if (r === "GET /events") { need("owner"); return json(await platform.events(url.searchParams.get("artifact") ?? undefined)); }

  return json({ error: "not found" }, 404);
}

const pub = (v: Viewer) => ({ kind: v.kind, id: v.id, name: v.name });
// personal or shared (DoD 6): a version that declares viewer tools shows each viewer their own data, so its app
// room takes no writes from anyone (one viewer's data can never reach another through it). The version is the one this viewer
// sees; a version change closes every app socket (Room.versionChanged), so this is decided again on reconnect.
const personal = (m: Manifest) => (m.tools ?? []).some((t) => t.binding === "viewer");
// Link visitors who may write (R11): `from` = "v:" + a hash of their __Host-visitor
// cookie (32 random bytes, set on the link page), one id per browser. A hash, because every viewer of the room sees `from`: the
// cookie value itself would let anyone copy it and write as that visitor. No cookie (blocked, or not a browser): an id per
// socket. Clearing cookies gives a new id, so one vote per phone is best effort (ARCHITECTURE residual 20).
const VISITOR_RE = /^[A-Za-z0-9_-]{43}$/, VISITOR_TTL = 400 * 86400;
// the cookie goes only to a link visitor who may write now (switch on): with the switch off a visitor still gets no cookie (R10)
const visitorCookie = (req: Request, acc: { write: boolean; roomWrite: boolean }): Record<string, string> =>
  !acc.write && acc.roomWrite && !VISITOR_RE.test(cookieOf(req, "__Host-visitor") ?? "")
    ? { "set-cookie": setCookie("__Host-visitor", rand(32), VISITOR_TTL) } : {};
async function visitorFrom(req: Request) {
  const c = cookieOf(req, "__Host-visitor");
  const id = c && VISITOR_RE.test(c) ? b64u(await sha(c)).slice(0, 22) : rand(16);
  return "v:" + id;
}
const linkUrl = (env: Env, name: string, token: string | null) => (token ? `${env.APP_ORIGIN}/v/${encodeURIComponent(name)}?k=${token}` : null);
const TOOL_STATUS: Record<string, number> = { not_connected: 409, owner_not_connected: 409, unknown_tool: 403, not_read_only: 403, egress_denied: 502, upstream_error: 502 };

function page(env: Env, boot: Record<string, unknown>, status = 200, extra: Record<string, string> = {}) {
  const data = JSON.stringify({ appOrigin: env.APP_ORIGIN, ownerName: ownerName(env), ...boot }).replace(/</g, "\\u003c");
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Artifacts</title><link rel="stylesheet" href="/assets/shell.css"><script type="application/json" id="boot">${data}</script>
<script type="module" src="/assets/shell.js"></script></head><body><div id="root"></div></body></html>`,
    { status, headers: { ...COMMON, ...extra, "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": APP_CSP(env) } });
}

