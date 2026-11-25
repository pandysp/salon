// Chunk 3: MCP connections (encrypted), consents, the approval gate on versions.approved_at, tool calls, the sharing warning.
// Platform: one Durable Object ("main") with one SQLite database that is the single source of truth for guests, passkeys,
// invites, sessions, artifacts, sharing, versions (immutable, with their files) and the event log.
// Rooms live in their own objects (room.js); this object only calls them for seq / rollback / versionChanged.
// Every method is an RPC method called by the Worker after it has checked who is asking (index.ts); nothing here trusts input
// from an artifact.
import { DurableObject } from "cloudflare:workers";
import { loadServers, gatewayFetch, seal, unseal, provider, callMcp, authorize, EgressDenied, type ServerConfig, type ConnState } from "./tools";
import {
  generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse,
} from "@simplewebauthn/server";

export type Sharing = "private" | "invited" | "link";
// owner tools are named queries: their arguments are pinned here and the server refuses client arguments (spec: a guest can't
// send own arguments to the owner's account). `access` may be omitted; if given it must be "read" (v1).
// `server` names an MCP server in the owner's config (MCP_SERVERS), never a URL.
export type Tool = { name: string; server: string; binding: "owner" | "viewer"; access: "read"; args?: Record<string, unknown> };
export type Manifest = { title?: string; tools?: Tool[] };

const DAY = 86400_000;
const SESSION_TTL = 30 * DAY, INVITE_TTL = 14 * DAY, CHALLENGE_TTL = 5 * 60_000;
const MAX_CHALLENGES = 1000; // pending passkey ceremonies; the oldest make room (review F4b)
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const PATH_RE = /^(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*$/; // relative, no "..", no leading dot
const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8", json: "application/json", svg: "image/svg+xml", txt: "text/plain; charset=utf-8",
}; // text only in v1 (images as data: URIs or inline SVG)

const enc = new TextEncoder();
export const b64u = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const rand = (n = 32) => b64u(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async (s: string) => b64u(await crypto.subtle.digest("SHA-256", enc.encode(s)));
const fromB64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

export class UserError extends Error { constructor(public status: number, msg: string) { super(msg); } }
// the owner's display name in every text the UI and MCP show (env OWNER_NAME, default "Owner")
export const ownerName = (env: { OWNER_NAME?: string }) => env.OWNER_NAME?.trim() || "Owner";

export class Platform extends DurableObject<any> {
  #key: Promise<CryptoKey> | null = null;
  // Pending passkey ceremonies (sign-in and invite registration), flow -> challenge. In memory, not SQLite: anyone can start a
  // sign-in, and every SQLite transaction leaves a celld log file (.ltx), so an anonymous flood filled the disk at ~28 MB/s
  // (pre-Funnel review S1). This object stays loaded: celld evicts idle objects only with
  // CELLD_IDLE_EVICT_S ("Idle-cell eviction age (disabled unless set)", celld 0.6.3 --help), which no stack sets. A restart ends
  // the ceremonies in progress ("try again"). Map order = insertion order, so the first key is the oldest.
  #challenges = new Map<string, { kind: "register" | "signin"; challenge: string; invite: string | null; user_id: string | null; expires_at: number }>();
  constructor(ctx: DurableObjectState, env: any) {
    super(ctx, env);
    const s = ctx.storage.sql;
    for (const ddl of [
      "CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS guests (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL)",
      "CREATE TABLE IF NOT EXISTS credentials (id TEXT PRIMARY KEY, guest_id TEXT NOT NULL, public_key TEXT NOT NULL, counter INTEGER NOT NULL, transports TEXT, created_at INTEGER NOT NULL)",
      "DROP TABLE IF EXISTS challenges", // pending ceremonies live in memory now (#challenges; pre-Funnel review S1)
      "CREATE TABLE IF NOT EXISTS invites (token_hash TEXT PRIMARY KEY, artifact TEXT NOT NULL, label TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_by TEXT, used_at INTEGER)",
      // subject: "owner" (minted by the tailnet sign-in route) or "g:<guest id>" (passkey)
      "CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, subject TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)",
      "CREATE TABLE IF NOT EXISTS artifacts (name TEXT PRIMARY KEY, sharing TEXT NOT NULL, link_token TEXT, current_version INTEGER NOT NULL, created_at INTEGER NOT NULL)",
      "CREATE TABLE IF NOT EXISTS grants (artifact TEXT NOT NULL, guest_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (artifact, guest_id))",
      // approved_at: when the owner approved this version for guests. Set at publish for now (no owner-query approval yet); chunk 3
      // leaves it NULL when a republish changes the owner-tool set (spec DoD 5) and serves guests the latest approved version.
      "CREATE TABLE IF NOT EXISTS versions (artifact TEXT NOT NULL, version INTEGER NOT NULL, manifest TEXT NOT NULL, room_seq INTEGER NOT NULL, restored_from INTEGER, created_at INTEGER NOT NULL, approved_at INTEGER, PRIMARY KEY (artifact, version))",
      "CREATE TABLE IF NOT EXISTS files (artifact TEXT NOT NULL, version INTEGER NOT NULL, path TEXT NOT NULL, content_type TEXT NOT NULL, body BLOB NOT NULL, PRIMARY KEY (artifact, version, path))",
      "CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, artifact TEXT, viewer TEXT, detail TEXT)",
      // chunk 3: one MCP connection per (subject, server). data = AES-GCM(ConnState: OAuth client, tokens, PKCE verifier, pending
      // state); state_hash finds the row again at the OAuth callback. subject: "owner" or "g:<guest id>".
      "CREATE TABLE IF NOT EXISTS connections (subject TEXT NOT NULL, server TEXT NOT NULL, data BLOB NOT NULL, state_hash TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (subject, server))",
      // a viewer's yes to the viewer tools of one artifact version (a decline is never stored: the shell keeps it for the page)
      "CREATE TABLE IF NOT EXISTS consents (subject TEXT NOT NULL, artifact TEXT NOT NULL, version INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (subject, artifact, version))",
    ]) s.exec(ddl);
    // link_write (DECISIONS R11): The owner's per-page switch "link visitors may write
    // to the room", default off; added to databases made before it
    if (!s.exec("SELECT 1 FROM pragma_table_info('artifacts') WHERE name = 'link_write'").toArray().length)
      s.exec("ALTER TABLE artifacts ADD COLUMN link_write INTEGER NOT NULL DEFAULT 0");
  }
  #sql(q: string, ...a: any[]) { return this.ctx.storage.sql.exec(q, ...a).toArray() as any[]; }
  #one(q: string, ...a: any[]) { return this.#sql(q, ...a)[0] ?? null; }

  // ---- HMAC key for content capabilities; generated once, stored with the data ----
  #hmac() {
    return (this.#key ??= (async () => {
      let raw = this.#one("SELECT v FROM meta WHERE k = 'hmac'")?.v;
      if (!raw) { raw = rand(32); this.#sql("INSERT INTO meta (k, v) VALUES ('hmac', ?)", raw); }
      return crypto.subtle.importKey("raw", fromB64u(raw), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    })());
  }
  async #sign(v: string) { return b64u(await crypto.subtle.sign("HMAC", await this.#hmac(), enc.encode(v))); }
  // `bind`: signed in but not carried in `signed` (the caller looks it up again to verify)
  async #verify(signed: string, bind: string): Promise<string | null> {
    const i = signed.lastIndexOf(".");
    if (i < 0) return null;
    const v = signed.slice(0, i), sig = signed.slice(i + 1);
    // canonical encoding only: the last base64url char of a 32-byte MAC has 2 padding bits that decoders ignore, so without
    // this check one cap would have several valid spellings
    try { if (b64u(fromB64u(sig)) !== sig) return null; } catch { return null; }
    try { return (await crypto.subtle.verify("HMAC", await this.#hmac(), fromB64u(sig), enc.encode(`${v}~${bind}`))) ? v : null; } catch { return null; }
  }

  // ---- content capability: lets anyone holding it read the files of one artifact version, while that version is the
  // current one (owner, agent) or the latest approved one (guests, link viewers), no sharing change has happened since and
  // the cap has not expired. Handed out only after the access check (/api/view). ----
  // What a cap is bound to: the artifact's link token, which every sharing change replaces (review F3, R2). Signed in, never carried in the URL: a leaked file URL must not reveal the link.
  #capKey(a: { link_token: string | null }) { return a.link_token ?? ""; }
  async contentCap(artifact: string, version: number, ttlMs = 12 * 3600_000) {
    const v = `${artifact}~${version}~${Date.now() + ttlMs}`;
    return `${v}.${await this.#sign(`${v}~${this.#capKey(this.#artifact(artifact))}`)}`;
  }
  async readContent(cap: string, path: string) {
    const a = this.#one("SELECT current_version, link_token FROM artifacts WHERE name = ?", cap.split("~")[0]);
    if (!a) return null;
    const v = await this.#verify(cap, this.#capKey(a));
    if (!v) return null;
    const [artifact, version, exp] = v.split("~");
    if (Number(exp) < Date.now()) return null;
    if (a.current_version !== Number(version) && this.#approvedVersion(artifact) !== Number(version)) return null; // only what someone may see now
    const f = this.#one("SELECT content_type, body FROM files WHERE artifact = ? AND version = ? AND path = ?", artifact, Number(version), path);
    return f ? { contentType: f.content_type as string, body: f.body as ArrayBuffer } : null;
  }


  // ---- sessions (owner and guests) ----
  async session(token: string): Promise<{ subject: string; name: string | null } | null> {
    const s = this.#one("SELECT subject FROM sessions WHERE token_hash = ? AND expires_at > ?", await sha256(token), Date.now());
    if (!s) return null;
    if (s.subject === "owner") return { subject: "owner", name: null };
    const g = this.#one("SELECT name FROM guests WHERE id = ?", s.subject.slice(2));
    return g ? { subject: s.subject, name: g.name } : null;
  }
  async ownerSession() { this.event("owner-signin", null, "owner", null); return this.#newSession("owner"); }
  async #newSession(subject: string) {
    const token = rand(32), now = Date.now();
    this.#sql("INSERT INTO sessions (token_hash, subject, created_at, expires_at) VALUES (?, ?, ?, ?)", await sha256(token), subject, now, now + SESSION_TTL);
    return { token, maxAge: SESSION_TTL / 1000 };
  }

  async endSession(token: string) { this.#sql("DELETE FROM sessions WHERE token_hash = ?", await sha256(token)); }

  // ---- invites (one use each) ----
  async createInvite(artifact: string, label: string) {
    this.#artifact(artifact);
    label = String(label ?? "").trim().slice(0, 80);
    if (!label) throw new UserError(400, "an invite needs a label (who it is for)");
    const token = rand(24), now = Date.now();
    this.#sql("INSERT INTO invites (token_hash, artifact, label, created_at, expires_at) VALUES (?, ?, ?, ?, ?)", await sha256(token), artifact, label, now, now + INVITE_TTL);
    this.event("invite-created", artifact, "owner", { label });
    return { token };
  }
  async #invite(token: string) {
    const i = this.#one("SELECT * FROM invites WHERE token_hash = ?", await sha256(String(token)));
    if (!i) throw new UserError(404, "This invite link is not valid.");
    if (i.used_by) throw new UserError(410, "This invite link has already been used.");
    if (i.expires_at < Date.now()) throw new UserError(410, "This invite link has expired.");
    return i;
  }
  async inviteInfo(token: string) { const i = await this.#invite(token); return { artifact: i.artifact, label: i.label }; }
  // a guest who is already signed in accepts another invite without a new passkey
  async acceptInvite(token: string, guestId: string) {
    const i = await this.#invite(token);
    this.#useInvite(i, guestId);
    return { artifact: i.artifact as string };
  }
  // grant only to the call whose UPDATE marks the invite used: two registrations on one invite can both pass #invite() before
  // either gets here (registerVerify awaits in between), but only one UPDATE changes the row (review: invite race, hardening).
  #useInvite(i: any, guestId: string) {
    if (!this.#sql("UPDATE invites SET used_by = ?, used_at = ? WHERE token_hash = ? AND used_by IS NULL RETURNING token_hash", guestId, Date.now(), i.token_hash).length)
      throw new UserError(410, "This invite link has already been used.");
    this.#sql("INSERT OR IGNORE INTO grants (artifact, guest_id, created_at) VALUES (?, ?, ?)", i.artifact, guestId, Date.now());
    this.event("invite-used", i.artifact, "g:" + guestId, { label: i.label });
  }

  // ---- passkeys (WebAuthn, @simplewebauthn/server); rp = the app host ----
  #rp() { const u = new URL(this.env.APP_ORIGIN); return { rpID: u.hostname, origin: u.origin }; }
  async registerOptions(token: string) {
    const i = await this.#invite(token);
    const userId = rand(16);
    const options = await generateRegistrationOptions({
      rpName: "Artifacts", rpID: this.#rp().rpID, userName: i.label, userID: fromB64u(userId), attestationType: "none",
      authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
    });
    return { flow: this.#newChallenge("register", options.challenge, i.token_hash, userId), options };
  }
  // Anyone can start a sign-in (no identity needed), so memory must not grow with the number of calls (review F4b): of the
  // pending ceremonies only the newest MAX_CHALLENGES stay. A flood can then end other people's ceremonies in progress
  // ("sign-in attempt expired, try again"), but only while it lasts, and it writes nothing to disk (S1).
  #newChallenge(kind: "register" | "signin", challenge: string, invite: string | null = null, userId: string | null = null) {
    const flow = rand(16);
    if (this.#challenges.size >= MAX_CHALLENGES) this.#challenges.delete(this.#challenges.keys().next().value!);
    this.#challenges.set(flow, { kind, challenge, invite, user_id: userId, expires_at: Date.now() + CHALLENGE_TTL });
    return flow;
  }
  #takeChallenge(flow: string, kind: string) { // single use: taken even when it turns out wrong or expired
    const c = this.#challenges.get(String(flow));
    this.#challenges.delete(String(flow));
    if (c?.kind !== kind || c.expires_at < Date.now()) throw new UserError(400, "sign-in attempt expired, try again");
    return c;
  }
  async registerVerify(token: string, flow: string, response: any, name: string) {
    const i = await this.#invite(token);
    const c = this.#takeChallenge(flow, "register");
    if (c.invite !== i.token_hash) throw new UserError(400, "flow does not belong to this invite");
    const v = await verifyRegistrationResponse({ response, expectedChallenge: c.challenge, expectedOrigin: this.#rp().origin, expectedRPID: this.#rp().rpID });
    if (!v.verified || !v.registrationInfo) throw new UserError(400, "passkey could not be verified");
    const cred = v.registrationInfo.credential, guestId = c.user_id as string;
    this.#useInvite(i, guestId); // first: a registration that loses the race stores no guest and no passkey
    this.#sql("INSERT INTO guests (id, name, created_at) VALUES (?, ?, ?)", guestId, String(name ?? "").trim().slice(0, 80) || i.label, Date.now());
    this.#sql("INSERT INTO credentials (id, guest_id, public_key, counter, transports, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      cred.id, guestId, b64u(cred.publicKey), cred.counter, JSON.stringify(cred.transports ?? []), Date.now());
    return { artifact: i.artifact as string, session: await this.#newSession("g:" + guestId) };
  }
  async signinOptions() {
    const options = await generateAuthenticationOptions({ rpID: this.#rp().rpID, userVerification: "preferred" });
    return { flow: this.#newChallenge("signin", options.challenge), options };
  }
  async signinVerify(flow: string, response: any) {
    const c = this.#takeChallenge(flow, "signin");
    const cred = this.#one("SELECT * FROM credentials WHERE id = ?", String(response?.id));
    if (!cred) throw new UserError(401, "unknown passkey");
    const v = await verifyAuthenticationResponse({
      response, expectedChallenge: c.challenge, expectedOrigin: this.#rp().origin, expectedRPID: this.#rp().rpID,
      credential: { id: cred.id, publicKey: fromB64u(cred.public_key), counter: cred.counter, transports: JSON.parse(cred.transports) },
    });
    if (!v.verified) throw new UserError(401, "passkey could not be verified");
    this.#sql("UPDATE credentials SET counter = ? WHERE id = ?", v.authenticationInfo.newCounter, cred.id);
    this.event("signin", null, "g:" + cred.guest_id, null);
    return { session: await this.#newSession("g:" + cred.guest_id) };
  }

  // ---- artifacts, sharing, access ----
  #artifact(name: string) {
    const a = this.#one("SELECT * FROM artifacts WHERE name = ?", name);
    if (!a) throw new UserError(404, "no such artifact");
    return a;
  }
  // what a viewer may do with an artifact; null = no access (the Worker answers 404 so existence is not revealed).
  // `link`: everyone else needs the artifact's link token (k) on every request (page, view, room, tools, events).
  access(name: string, viewer: { kind: string; guestId?: string }, k?: string | null) {
    const a = this.#one("SELECT * FROM artifacts WHERE name = ?", name);
    if (!a) return null;
    const granted = viewer.kind === "guest" && !!this.#one("SELECT 1 AS x FROM grants WHERE artifact = ? AND guest_id = ?", name, viewer.guestId);
    const owner = viewer.kind === "owner" || viewer.kind === "agent"; // the agent (pi) sees what the owner sees, but has no owner actions
    const linkOk = a.sharing === "link" && !!a.link_token && k === a.link_token;
    const view = owner || (a.sharing !== "private" && granted) || linkOk;
    if (!view) return null;
    // the owner (and pi) see the current version; everyone else the latest version the owner approved (none yet = no access)
    const version = owner ? a.current_version as number : this.#approvedVersion(name);
    const write = owner || (granted && a.sharing !== "private");
    if (version === null) return null;
    const v = this.#one("SELECT manifest FROM versions WHERE artifact = ? AND version = ?", name, version);
    return {
      name, sharing: a.sharing as Sharing, version, manifest: JSON.parse(v.manifest) as Manifest,
      // comments: owner and invited guests; not link viewers. The agent (pi) joins too, but the comments room gives it only its
      // gated view (comments.js agentItems: The owner's, minus those he kept from pi, and forwarded comments; 2026-11-25 pin-agent-toggle)
      comment: viewer.kind === "owner" || viewer.kind === "agent" || (granted && a.sharing !== "private"),
      // room writes and tools (owner and viewer tools alike): everyone with access except link visitors (access only through the
      // link token, no grant), who view only (spec, the owner; R10). An invited guest keeps
      // both kinds of tools when the page switches to link (the tool rule; the separate invited-only viewerTools flag is gone)
      write,
      // app-room writes: `write`, plus link visitors while the owner's switch is on and sharing is link (R11). Tools, consent and comments keep asking `write` (and `comment`), so they stay closed to visitors
      roomWrite: write || (linkOk && a.link_write === 1),
    };
  }
  // the switch "link visitors may write to the room" (R11): The owner only (index.ts), logged, and every open app socket is closed
  // so each reconnects with its write right decided again (a visitor socket opened before turns read-only, and vice versa)
  async setLinkWrite(name: string, on: boolean) {
    if (typeof on !== "boolean") throw new UserError(400, "on must be true or false");
    const a = this.#artifact(name);
    if (on && a.sharing !== "link") throw new UserError(409, "link visitors can write only while sharing is 'anyone with the link'");
    this.#sql("UPDATE artifacts SET link_write = ? WHERE name = ?", on ? 1 : 0, name);
    this.event("link-write", name, "owner", { from: a.link_write === 1, to: on });
    await this.env.ROOM.getByName("app:" + name).versionChanged();
    return { link_write: on };
  }
  async setSharing(name: string, mode: Sharing) {
    if (!["private", "invited", "link"].includes(mode)) throw new UserError(400, "sharing must be private | invited | link");
    const a = this.#artifact(name); // `a` for the share warning below
    // a fresh token on every sharing change (review F3, R2): a leaked link stays dead after
    // the owner revokes it, and since caps are bound to the token (#capKey), every change also ends the file URLs handed out before
    const link = rand(24);
    // leaving link mode turns link writes off (R11): a later link starts read-only again, as every new link does
    const linkWrite = mode === "link" && a.link_write === 1;
    this.#sql("UPDATE artifacts SET sharing = ?, link_token = ?, link_write = ? WHERE name = ?", mode, link, linkWrite ? 1 : 0, name);
    // spec: sharing a page with owner-bound tools beyond private shows the owner a warning (the shell displays it; logged here)
    const ownerTools = ((JSON.parse(this.#one("SELECT manifest FROM versions WHERE artifact = ? AND version = ?", name, a.current_version).manifest) as Manifest).tools ?? [])
      .filter((t) => t.binding === "owner").map((t) => `${t.server}/${t.name}`);
    const warning = mode !== "private" && ownerTools.length > 0
      ? `This page runs queries with YOUR accounts (${ownerTools.join(", ")}). Your invited guests see their results; link visitors don't.` : null; // the tool rule (R10): only owner and granted guests run tools
    this.event("sharing", name, "owner", { mode, ...(warning ? { warning } : {}), ...(a.link_write === 1 && !linkWrite ? { link_write: { from: true, to: false } } : {}) });
    // every open app socket reconnects and is decided again: a revoked link visitor loses the live room, a writing visitor its
    // write right (R11)
    await this.env.ROOM.getByName("app:" + name).versionChanged();
    return { sharing: mode, link_token: mode === "link" ? link : null, warning, link_write: linkWrite };
  }
  listFor(viewer: { kind: string; guestId?: string }) {
    if (viewer.kind === "owner" || viewer.kind === "agent") return this.#sql("SELECT name, sharing, current_version AS version FROM artifacts ORDER BY created_at DESC");
    if (viewer.kind === "guest") return this.#sql("SELECT a.name, a.sharing, a.current_version AS version FROM artifacts a JOIN grants g ON g.artifact = a.name WHERE g.guest_id = ? AND a.sharing != 'private' ORDER BY a.created_at DESC", viewer.guestId);
    return [];
  }
  // the live link token while sharing is link, else null. index.ts gives it to the owner only (R2)
  link(name: string): string | null { const a = this.#artifact(name); return a.sharing === "link" ? a.link_token : null; }
  // owner and agent read this: no link_token, so the agent cannot hand out a link; the owner's copy comes from link() (review F3, R2)
  details(name: string) {
    const a = this.#artifact(name);
    return {
      name: a.name, sharing: a.sharing, current_version: a.current_version, created_at: a.created_at, link_write: a.link_write === 1,
      versions: this.#sql("SELECT version, room_seq, restored_from, created_at, approved_at, manifest FROM versions WHERE artifact = ? ORDER BY version", name)
        .map((v) => ({ ...v, manifest: JSON.parse(v.manifest) })),
    };
  }

  // ---- publish (immutable versions) and rollback ----
  async publish(name: string, manifest: Manifest, files: Record<string, string>, by: string) {
    if (!NAME_RE.test(String(name))) throw new UserError(400, "artifact name: lowercase letters, digits, dashes (max 63)");
    const m = validateManifest(manifest, this.#servers());
    const rows = Object.entries(files ?? {}).map(([path, f]) => {
      if (!PATH_RE.test(path)) throw new UserError(400, `bad file path: ${path}`);
      const ext = path.split(".").pop()!.toLowerCase();
      if (!TYPES[ext]) throw new UserError(400, `unsupported file type: ${path}`);
      if (typeof f !== "string") throw new UserError(400, `file ${path}: text expected`);
      const body = enc.encode(f);
      return { path, type: TYPES[ext], body };
    });
    if (!rows.some((r) => r.path === "index.html")) throw new UserError(400, "a bundle needs index.html");
    const room = this.env.ROOM.getByName("app:" + name);
    const seq: number = await room.seq();
    const approved = !this.#needsApproval(name, m);
    const version = this.#insertVersion(name, m, seq, null, approved, (v) => {
      for (const r of rows) this.#sql("INSERT INTO files (artifact, version, path, content_type, body) VALUES (?, ?, ?, ?, ?)", name, v, r.path, r.type, r.body);
    });
    await room.versionChanged(); // open shells reconnect and re-read /api/view (room.js)
    this.event("publish", name, by, { version, room_seq: seq, files: rows.length, approved });
    return { version, room_seq: seq, approved };
  }
  #insertVersion(name: string, m: Manifest, seq: number, restoredFrom: number | null, approved: boolean, copyFiles: (v: number) => void) {
    const a = this.#one("SELECT current_version FROM artifacts WHERE name = ?", name);
    const version = (this.#one("SELECT COALESCE(MAX(version), 0) AS v FROM versions WHERE artifact = ?", name).v as number) + 1;
    const now = Date.now();
    this.#sql("INSERT INTO versions (artifact, version, manifest, room_seq, restored_from, created_at, approved_at) VALUES (?, ?, ?, ?, ?, ?, ?)", name, version, JSON.stringify(m), seq, restoredFrom, now, approved ? now : null);
    copyFiles(version);
    if (a) this.#sql("UPDATE artifacts SET current_version = ? WHERE name = ?", version, name);
    else this.#sql("INSERT INTO artifacts (name, sharing, current_version, created_at) VALUES (?, 'private', ?, ?)", name, version, Date.now());
    return version;
  }
  // rollback = a new version with the old version's code and manifest; the app room is cut back to the old version's seq
  // (later messages move to the room's archive table)
  async rollback(name: string, to: number) {
    this.#artifact(name);
    const old = this.#one("SELECT * FROM versions WHERE artifact = ? AND version = ?", name, Number(to));
    if (!old) throw new UserError(404, `no version ${to}`);
    const room = this.env.ROOM.getByName("app:" + name);
    const { archived, restored } = await room.rollback(old.room_seq, `rollback to v${old.version}`);
    // a rollback is the owner's own action in the shell, so it counts as his approval
    const version = this.#insertVersion(name, JSON.parse(old.manifest), old.room_seq, old.version, true, (v) =>
      this.#sql("INSERT INTO files (artifact, version, path, content_type, body) SELECT artifact, ?, path, content_type, body FROM files WHERE artifact = ? AND version = ?", v, name, old.version));
    await room.versionChanged(); // open shells reconnect and re-read /api/view (room.js)
    this.event("rollback", name, "owner", { to: old.version, version, room_seq: old.room_seq, archived, restored });
    return { version, restored_from: old.version, room_seq: old.room_seq, archived, restored };
  }

  // ---- approval gate (spec DoD 5 / briefing): guests see a new version only after the owner approves it when the version has
  // viewer tools, or when its owner-query set differs from the version guests see now. Otherwise it is approved at publish.
  #approvedVersion(name: string): number | null {
    return this.#one("SELECT MAX(version) AS v FROM versions WHERE artifact = ? AND approved_at IS NOT NULL", name)?.v ?? null;
  }
  #needsApproval(name: string, m: Manifest) {
    if ((m.tools ?? []).some((t) => t.binding === "viewer")) return true;
    const ov = this.#approvedVersion(name);
    const before = ov === null ? { tools: [] } : JSON.parse(this.#one("SELECT manifest FROM versions WHERE artifact = ? AND version = ?", name, ov).manifest);
    return ownerQueries(before) !== ownerQueries(m);
  }
  async approve(name: string, version: number) {
    this.#artifact(name);
    const v = this.#one("SELECT version, approved_at FROM versions WHERE artifact = ? AND version = ?", name, Number(version));
    if (!v) throw new UserError(404, `no version ${version}`);
    if (v.approved_at === null) this.#sql("UPDATE versions SET approved_at = ? WHERE artifact = ? AND version = ?", Date.now(), name, v.version);
    await this.env.ROOM.getByName("app:" + name).versionChanged(); // open guest shells reconnect and re-read /api/view
    this.event("approve", name, "owner", { version: v.version });
    return { version: v.version, approved: true };
  }
  // what the owner panel shows: which version guests see, and the waiting one (with its owner queries) if any
  approval(name: string) {
    const a = this.#artifact(name), guests = this.#approvedVersion(name);
    const cur = this.#one("SELECT version, approved_at, manifest FROM versions WHERE artifact = ? AND version = ?", name, a.current_version);
    return {
      guestsSee: guests,
      waiting: cur.approved_at === null ? { version: cur.version, tools: (JSON.parse(cur.manifest) as Manifest).tools ?? [] } : null,
    };
  }

  // ---- MCP servers (the owner's config) and connections ----
  #srv: Map<string, ServerConfig> | null = null;
  #servers() { return (this.#srv ??= loadServers(this.env.MCP_SERVERS)); }
  #server(name: string) {
    const s = this.#servers().get(name);
    if (!s) throw new UserError(404, `no MCP server "${name}" in the platform's config`);
    return s;
  }
  #fetch(s: ServerConfig) { return gatewayFetch(s, (origin) => { console.log(`egress denied for MCP server ${s.name}: ${origin}`); this.event("egress-denied", null, null, { server: s.name, origin }); }); }
  #redirectUrl() { return `${this.env.APP_ORIGIN}/api/connect/callback`; }
  #locks = new Map<string, Promise<unknown>>();
  // runs fn with the decrypted connection state of (subject, server), one at a time per connection (refresh tokens rotate,
  // so two concurrent refreshes would log the viewer out); save() re-encrypts and stores it
  async #withConn<T>(subject: string, server: string, fn: (st: ConnState, save: () => Promise<void>) => Promise<T>): Promise<T> {
    const key = `${subject}|${server}`, prev = this.#locks.get(key) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(async () => { // a failed earlier call must not block this one; its error went to its own caller
      const aad = `${subject}|${server}`, row = this.#one("SELECT data FROM connections WHERE subject = ? AND server = ?", subject, server);
      const st: ConnState = row ? await unseal(this.env, row.data, aad) : {};
      const save = async () => {
        const data = await seal(this.env, st, aad);
        this.#sql("INSERT INTO connections (subject, server, data, state_hash, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (subject, server) DO UPDATE SET data = excluded.data, state_hash = excluded.state_hash, updated_at = excluded.updated_at",
          subject, server, data, st.state ? await sha256(st.state) : null, Date.now());
      };
      return fn(st, save);
    });
    this.#locks.set(key, run);
    try { return await run; } finally { if (this.#locks.get(key) === run) this.#locks.delete(key); }
  }
  // OAuth step 1 (POST from the shell): dynamic client registration if needed, PKCE, state; returns the URL to send the browser to
  async connectStart(subject: string, serverName: string, returnTo: string) {
    const server = this.#server(serverName);
    if (server.auth !== "oauth") throw new UserError(400, `server "${server.name}" needs no connection`);
    return this.#withConn(subject, server.name, async (st, save) => {
      delete st.tokens; // an explicit (re)connect: otherwise the SDK would just refresh the old tokens
      st.state = rand(24); st.returnTo = returnTo; st.stateExp = Date.now() + 10 * 60_000;
      await save();
      let to: URL | null = null;
      const r = await authorize(provider(this.#redirectUrl(), server, st, save, (u) => (to = u)), server, this.#fetch(server)).catch(upstream(server));
      if (r !== "REDIRECT" || !to) throw new UserError(502, `server "${server.name}" did not ask for authorization`);
      const url: URL = to;
      // the browser follows this URL; it must belong to the configured server too (the metadata could point anywhere)
      if (!server.origins.includes(url.origin)) throw new UserError(502, `authorization endpoint ${url.origin} is not configured for "${server.name}"`);
      this.event("connect-start", null, subject, { server: server.name });
      return { authorize_url: url.href };
    });
  }
  // OAuth step 2 (the redirect back, GET /api/connect/callback): only the subject that started the flow can finish it
  async connectFinish(subject: string, state: string, code: string) {
    const row = this.#one("SELECT subject, server FROM connections WHERE state_hash = ?", await sha256(String(state)));
    if (!row) throw new UserError(400, "unknown or already used connection attempt; start again from the page");
    if (row.subject !== subject) throw new UserError(403, "this connection was started by someone else");
    const server = this.#server(row.server);
    return this.#withConn(subject, server.name, async (st, save) => {
      if (st.state !== state || !st.stateExp || st.stateExp < Date.now()) throw new UserError(400, "connection attempt expired; start again");
      const returnTo = st.returnTo ?? "/";
      delete st.state; delete st.returnTo; delete st.stateExp;
      await save();
      const r = await authorize(provider(this.#redirectUrl(), server, st, save, () => {}), server, this.#fetch(server), String(code)).catch(upstream(server));
      delete st.verifier; await save();
      if (r !== "AUTHORIZED" || !st.tokens) throw new UserError(502, `server "${server.name}" did not issue tokens`);
      this.event("connect", null, subject, { server: server.name });
      return { returnTo };
    });
  }
  // ---- consent (viewer tools, per artifact version) ----
  hasConsent(subject: string, artifact: string, version: number) {
    return !!this.#one("SELECT 1 AS x FROM consents WHERE subject = ? AND artifact = ? AND version = ?", subject, artifact, version);
  }
  consent(subject: string, artifact: string, version: number) {
    this.#sql("INSERT OR IGNORE INTO consents (subject, artifact, version, created_at) VALUES (?, ?, ?, ?)", subject, artifact, version, Date.now());
    this.event("consent", artifact, subject, { version });
    return { ok: true };
  }

  // ---- tool calls. The Worker has checked access, manifest, binding, pinned args and consent; `subject` is whose account
  // runs it ("owner" for owner tools, the viewer for viewer tools), `viewer` who asked. Every call is logged. ----
  async callTool(artifact: string, tool: Tool, args: Record<string, unknown>, subject: string, viewer: string) {
    const server = this.#server(tool.server), account = `${subject} via ${server.name}`, t0 = Date.now();
    const res: any = await this.#withConn(subject, server.name, async (st, save) => {
      // an owner query without the owner's connection: a guest cannot fix that (connecting would link the guest's own account)
      if (server.auth === "oauth" && !st.tokens) return subject === "owner" && viewer !== "owner"
        ? { ok: false, error: "owner_not_connected", message: `${ownerName(this.env)} has not connected "${server.name}" yet` }
        : { ok: false, error: "not_connected", server: server.name };
      let lostAuth = false;
      const auth = server.auth === "oauth" ? provider(this.#redirectUrl(), server, st, save, () => (lostAuth = true)) : undefined;
      try {
        return await callMcp(server, this.#fetch(server), auth, tool.name, args);
      } catch (e: any) {
        if (e instanceof EgressDenied) return { ok: false, error: "egress_denied", message: e.message };
        // refresh failed or the server revoked us: the SDK wanted a new authorization -> the viewer has to connect again
        if (lostAuth || e?.name === "UnauthorizedError") { delete st.tokens; await save(); return { ok: false, error: "not_connected", server: server.name }; }
        console.log(`mcp ${server.name}/${tool.name} for ${subject}: ${e?.stack ?? e}`);
        return { ok: false, error: "upstream_error", message: String(e?.message ?? e).slice(0, 300) };
      }
    });
    this.event("tool-call", artifact, viewer, { tool: tool.name, server: server.name, binding: tool.binding, account, ok: res.ok, ...(res.ok ? {} : { error: res.error }), ms: Date.now() - t0 });
    return res;
  }

  // ---- event log ----
  event(kind: string, artifact: string | null, viewer: string | null, detail: unknown) {
    this.#sql("INSERT INTO events (ts, kind, artifact, viewer, detail) VALUES (?, ?, ?, ?, ?)", Date.now(), kind, artifact, viewer, detail == null ? null : JSON.stringify(detail));
  }
  events(artifact?: string) {
    return (artifact ? this.#sql("SELECT * FROM events WHERE artifact = ? ORDER BY id", artifact) : this.#sql("SELECT * FROM events ORDER BY id DESC LIMIT 500"))
      .map((e) => ({ ...e, detail: e.detail ? JSON.parse(e.detail) : null }));
  }
}

export function validateManifest(m: any, servers: Map<string, ServerConfig>): Manifest {
  if (m == null || typeof m !== "object" || Array.isArray(m)) throw new UserError(400, "manifest must be an object");
  const out: Manifest = {};
  if (m.title != null) out.title = String(m.title).slice(0, 200);
  const tools = m.tools ?? [];
  if (!Array.isArray(tools)) throw new UserError(400, "manifest.tools must be an array");
  out.tools = tools.map((t: any) => {
    if (!t || typeof t.name !== "string" || !t.name) throw new UserError(400, "each tool needs a name");
    if (t.binding !== "owner" && t.binding !== "viewer") throw new UserError(400, `tool ${t.name}: binding must be owner | viewer`);
    if (t.access !== undefined && t.access !== "read") throw new UserError(400, `tool ${t.name}: v1 allows only access: "read"`);
    if (typeof t.server !== "string" || !servers.has(t.server)) throw new UserError(400, `tool ${t.name}: server must name an MCP server in the platform's config (${[...servers.keys()].join(", ")})`);
    if (t.args !== undefined && (t.args === null || typeof t.args !== "object" || Array.isArray(t.args))) throw new UserError(400, `tool ${t.name}: args must be an object`);
    if (t.binding === "viewer" && t.args !== undefined) throw new UserError(400, `tool ${t.name}: only owner tools have pinned args`);
    return { name: t.name, server: t.server, binding: t.binding, access: "read",
      ...(t.binding === "owner" ? { args: t.args ?? {} } : {}) };
  });
  return out;
}

// an OAuth step failed at the MCP server's side (refused egress, a redirect the SDK does not follow, an error answer): say so
// to the viewer as a 502 with the reason, and log it
const upstream = (server: ServerConfig) => (e: any): never => {
  console.log(`oauth ${server.name}: ${e?.stack ?? e}`);
  throw e instanceof UserError ? e : new UserError(502, e instanceof EgressDenied ? e.message : `MCP server "${server.name}": ${String(e?.message ?? e).slice(0, 300)}`);
};

// the owner-query set of a manifest (server, tool, pinned args), for the approval gate. Reordered arg keys count as a change:
// one extra approval, never a missed one.
const ownerQueries = (m: Manifest) =>
  JSON.stringify((m.tools ?? []).filter((t) => t.binding === "owner").map((t) => JSON.stringify([t.server, t.name, t.args ?? {}])).sort());
