# Artifacts platform: architecture

**What it is:** pages that the owner's agents publish (static bundles plus a manifest), viewed through a trusted *shell* page,
with live shared state (*rooms*), shared privately, with named guests, or by link. One platform Worker on celld 0.6.3,
in Docker, reached through two Tailscale Funnel hostnames.

Read in this order: **Map** → **Security model** → **Residual risks**.
Decisions behind it (with alternatives): [`DECISIONS.md`](DECISIONS.md).

## Map

```
browser ──https──▶ app host (artifacts-app node)          browser ──https──▶ content host (artifacts-usercontent node)
                    tailscaled serve/funnel → 127.0.0.1:8080                  tailscaled serve/funnel → http://artifacts-app:8080
                    └──────────────▶ celld (artifacts-app container, 0.0.0.0:8080 on the private docker network) ◀──┘
                                       one Worker: src/worker/index.ts, routes by Host
                                         ├─ Platform DO "main" (src/worker/platform.ts): guests, passkeys, invites, sessions,
                                         │    artifacts, sharing, immutable versions + files, event log, MCP connections
                                         │    (encrypted), consents (one SQLite DB); makes every MCP call ──▶ allowlisted MCP
                                         │    servers only (the owner's config: the Studio via host gateway, Attio)
                                         └─ Room DO per room (src/worker/room.js): "app:<artifact>", "comments:<artifact>"
```

| Path | What |
|---|---|
| `src/worker/index.ts` | routing (app vs content host), identity, Origin check, all HTTP/WebSocket routes, CSPs |
| `src/worker/platform.ts` | `Platform` Durable Object: the single source of truth except room messages |
| `src/worker/tools.ts` | chunk 3: The owner's MCP server config, the egress allowlist (`gatewayFetch`), token encryption, the SDK client call |
| `src/worker/room.js` | `Room` Durable Object: bake-off room protocol + `from` stamp + `$` reserved types + seq/rollback/archive |
| `src/worker/comments.js` | comments-room rules (`checkComment`) and **the gate for pi** (`agentItems`); pure, also bundled into the shell (chunk 4) |
| `src/worker/mcp.ts` | pi's authoring MCP endpoint `POST /api/mcp` (chunk 4) |
| `integrations/pi/artifact-bridge.ts` | the pi extension: `publish_artifact {name, dir}` (local build) + comment push/replay (chunk 4) |
| `src/shell/main.jsx` | the shell (Solid 2): home, sign-in, invite, viewer page (iframe, room sockets, SDK broker, comments, owner panel) |
| `src/sdk/artifact-sdk.js` | the plain-JS SDK artifacts load from `/_sdk/artifact-sdk.js` on the content host |
| `lib/bundle-artifact.mjs` | `bundleArtifact(dir)`: compiles a Solid 2 artifact (or takes a static folder) into a publish payload |
| `scripts/build.mjs` | builds `app/worker.js` (Worker + shell bundle + SDK inlined) |
| `infra/`, `scripts/up.sh` `down.sh` `status.sh` | container image and ops (`local` or `prod`) |
| `infra/*.mcp.json` | The owner's MCP server config per stack (`MCP_CONFIG` in the env file); `infra/prod.mcp.json` for production |
| `artifacts/studio-status`, `my-items`, `attio-companies` | example pages for use case A (owner queries), B (viewer tools), B on real Attio |
| `tests/` | Playwright suite (`npm test`), test-only tailnet proxy, adversarial fixture, test MCP servers (`tests/fixtures/mcp-*`), negative controls |

### Hosts and config
`APP_ORIGIN`, `CONTENT_ORIGIN`, `OWNER_LOGINS` (comma list), `AGENT_TOKEN` come from `infra/<mode>.env` → container env →
`/app/.dev.vars` (`prod.env` is gitignored: it holds the agent token). Chunk 3 adds `MCP_SERVERS` (the JSON file named by
`MCP_CONFIG`, mounted at `/run/config/mcp.json`) and `TOKEN_KEY` (the file named by `TOKEN_KEY_FILE`, mounted at
`/run/secrets/token-key`); local stacks get both from `scripts/local-env.sh`, prod from `scripts/stack.sh`.
The Worker compares the request's **host** with the two configured hosts (not the origin: tailscale serve terminates TLS
and forwards plain http, keeping `Host`). Any other host gets 421. Switching from the local names (`https://app.localtest.me:8340`
/ `https://content.localtest.me:8340`, same site like production, behind the test proxy) to the real `*.ts.net` names is a
config change.

### Routes
App host (shell pages render from one bundle; the server decides access and passes boot data as JSON, no inline script):
- pages: `/`, `/signin`, `/invite/<token>`, `/v/<artifact>[?k=<link token>]` (the viewer)
- `GET /api/me`, `GET /api/artifacts` (owner/agent: all; guest: granted), `GET /api/view/<artifact>[?k=]` (current version + content URL)
- owner or agent: `GET /api/artifacts/<n>` (name, sharing, version, versions; the agent never sees the link, the owner gets
  `link`: the live link URL while sharing is `link`, read without rotating it; R2), `POST /api/artifacts/<n>/versions` (publish `{manifest, files}`)
- owner only: `POST …/rollback {version}`, `POST …/sharing {mode}` (→ `{url}` with a **new** link token for `link`, every time; R2),
  `POST …/invites {label}` → `{url}`, `GET …/archive`, `GET /api/events[?artifact=]`
- sign-in: `POST /api/signin/owner` (tailnet header → owner session), passkeys: `GET /api/invites/<t>`,
  `POST /api/invites/<t>/options|verify|accept`, `POST /api/signin/options|verify`, `POST /api/signout`
- rooms (WebSocket): `/api/rooms/<artifact>/app`, `/api/rooms/<artifact>/comments` (the agent may join comments: gated view)
- agent only: `POST /api/mcp` (MCP: `publish_artifact`, `list_artifacts`, `get_comments`, `reply_comment`, `resolve_comment`)
- `POST /api/tools/<artifact>/<tool>[?k=]`: access, manifest, binding, pinned args, consent, then the MCP call (chunk 3)
- chunk 3: `POST /api/consent/<artifact> {version}`, `POST /api/connect/<server>/start {return}` (→ `{authorize_url}`),
  `GET /api/connect/callback?state&code` (OAuth redirect target), owner: `POST /api/artifacts/<n>/versions/<v>/approve`;
  `/api/view` also returns `consent` (viewer tools of this version, asked or not) and, for the owner, `approval`

Content host: `GET /_sdk/artifact-sdk.js` and `GET /c/<cap>/<path>`; everything else 404. `<cap>` =
`<artifact>~<version>~<expiry>.<HMAC>` (12 h, and only while that version is the current one and no sharing change has
happened since: the HMAC also covers the artifact's link token, which every `setSharing` replaces; the token is signed in,
never carried in the URL; R2); the HMAC key is generated once and stored in the Platform DB. Document types are served only for their one use (`Sec-Fetch-Dest`): HTML only as `iframe` (the
shell's frame), SVG only as `image`; opened top-level they answer 403 (R7).

### Rooms
The bake-off protocol, unchanged for clients: send any JSON object; the server stores it and broadcasts it with `seq`, `ts`
and now **`from`** (the authenticated viewer id: `owner`, `agent` or `g:<id>`; client values are overwritten). A link visitor's
socket (access only through the link, no grant; `Platform.access()` → `write` false) has no `from` and is read-only: it gets the history and every broadcast, and any frame it sends closes it (4003 "view
only"); the Worker never passes on a client-sent `x-room-from` (R10). **Unless the owner turns on "link visitors may write to the
room" for the page** (R11; `access()` → `roomWrite`): then a link visitor writes to the app room as `v:<hash of its
__Host-visitor cookie>` (one id per browser; without the cookie one per socket), still with no comments and no tools; the
switch and every sharing change close all app sockets (4012) so each is decided again. On every
(re)connect and after a rollback the server sends `{type:"history", messages}`. Types starting with `$` are the platform's:
a client sending one is disconnected (close 4003; celld 0.6.3 refuses 1003); the platform sends none since T16. **A version that
declares viewer tools has a read-only app room** for everyone (DoD 6, T16), and every new version closes all app sockets
(4012) so each reconnects under the version its viewer now sees. Caps: 64 KB per message (close 4003), 100 messages per 10 s per socket (close 4008), and
**1 MiB per live room** (close 4009 "room full"; for pi's MCP tools a tool error). Each stored row counts as it appears in the
history frame (body + `from` + 64 bytes), so every history frame stays under 1 MiB; the archive does not count, so a rollback
frees space, and a rollback that would restore more than 1 MiB is refused (409). R4.
The shell owns the sockets; the artifact sees the app room only through the SDK.

### Comments and pi (chunk 4)
`comments:<artifact>` is a room like the app room, but the Worker marks it (`x-room-kind`, kept in the socket attachment)
and the room runs every message through `checkComment()` (`src/worker/comments.js`): `comment {id, text, version?, forPi?}` by the
owner or an invited guest (`forPi: false`, owner only: "Send to agent" unticked); `forward {comment}` by the owner only; `reply {comment, text}` and `resolve {comment}` by pi only,
on a thread pi can see. Anything else closes the socket (4003) and is not stored. Writers: the shell (people) and the
Worker on pi's behalf (MCP tools → `Room.postComment`); never artifact code (DECISIONS.md A4).
**The gate:** `agentItems(messages)` is the only definition of what pi sees: The owner's threads (except those sent with `forPi: false`) and the ones he forwarded,
with replies and resolved state. pi's socket gets `{type:"history", messages: agentItems(...)}` on connect and after every
append, never the raw log; `get_comments` returns the same; the shell's "for pi" badge uses it too. Each item's `seq` is
the seq at which it became visible to pi, which the bridge compares with its last delivered seq.
**The bridge** (`integrations/pi/artifact-bridge.ts`): a session follows the artifacts it publishes or names in
`follow_artifact` (stored in the pi session; DECISIONS.md A14), joins their comments rooms with the bearer token, injects open items above the last delivered seq as one
follow-up message, then saves that seq in `artifact-bridge.state.json` next to the extension (all sessions of the install
share it, keyed by origin). Replay falls out of the history frame on every (re)connect; tested for a network drop (the
bridge reconnects by itself), a session stopped and resumed, a session killed and revived (real pi), a fresh session
that republishes and a fresh session that follows without republishing. Delivery is at least once.
**Comment pins**: the shell's 💬 button (only with `canComment`) sends
`comment.mode {on}` over the SDK port; the SDK then frames the hovered element and turns a click into
`comment.pick {text, rect}` (visible text, max 300 chars, and its box; never HTML). The shell takes a pick only while comment
mode is on, pins a composer there and, when the owner or a guest sends it, writes an ordinary `comment` whose text starts with
the quote (`> quote\n\ncomment`). "Send to agent" (pin and Comments panel) is a real box for the owner, on by default; unticked,
the comment carries `forPi: false`, stays out of pi's view and can be forwarded later like a guest's; guests get no box (the owner forwards). No re-anchoring, no pins on old comments.
Pages without the SDK (a hand-written `index.html` that skips it) get no comment mode.

### Versions
Every publish is an immutable version (files + manifest + the app room's `seq` at that moment). Rollback to vK creates a
new version with vK's files and sets the live room to exactly the messages with `seq <= room_seq(vK)`; the rest move to the
room's `archive` table (and come back if a later rollback includes them). Nothing is deleted; seqs are never reused.
Open viewers switch versions live: a new version closes the room's sockets, the shell reconnects, re-reads `/api/view` (on
every reconnect) and mounts a fresh iframe if the version changed (T16); the SDK re-sends the room state to the new frame.

## Tools (chunk 3)
How an artifact gets data: the page calls `artifact.tools.call(name, args)`; the shell posts it to `/api/tools/<artifact>/<name>`;
the Worker checks access, that the **served** version's manifest declares the tool, the binding, pinned args and consent; the
Platform object runs the call and logs it.
- **The owner's config, not the manifest, says where MCP servers are** (`infra/*.mcp.json`):
  `{"<server>": {"url", "auth": "none"|"oauth", "oauthOrigins"?}}`. A manifest tool names a configured server (publish refuses
  others). Production: `infra/prod.mcp.json` (the Studio fixture on 127.0.0.1:8220 via Docker's host gateway, + Attio).
- **Owner tools** (`binding: owner`) are named queries with pinned `args`; they run on the owner's account (`owner` connection, or
  none for `auth: none` servers). **Viewer tools** run on the signed-in viewer's own connection, only after that viewer's consent
  for this version, and make the page's room read-only (DoD 6, T16). **Both kinds** run for the owner and for guests with a grant
  while sharing is not private, so invited guests keep them on a link page; link visitors get none (the tool rule, R10).
- **Read-only** = the server marks the tool `readOnlyHint` (checked with `tools/list` on every call); publish refuses
  `access` other than `read`.
- **Connections**: one row per (subject, server) in `connections`, the whole OAuth state AES-256-GCM sealed (T3). OAuth with
  dynamic client registration + PKCE + `state` through the SDK; tokens refresh on a 401 (serialised per connection, T1); a failed
  refresh or a revoked grant → `not_connected` → the shell shows "Connect <server>".
- **Approval gate** (T6): guests and link viewers see the latest version the owner approved; a version with viewer tools, or with a
  changed owner-query set, waits for his Approve button (the owner bar lists its tools). `readContent()` serves the current
  and the latest approved version.
- **Consent** (T5): the shell shows a dialog before the first viewer-tool call of a version; the frame's calls wait for the
  answer; "not now" answers `declined` to the page without calling anything.
- **Call log**: `tool-call` events (`/api/events?artifact=`): tool, server, binding, `account` (`owner via studio`,
  `g:<id> via items`), ok/error, duration.

## Security model

**Same site, separate origins.** `ts.net` is the Public Suffix List entry, so both production hosts
(`artifacts-app.<tailnet>.ts.net`, `artifacts-usercontent.<tailnet>.ts.net`) are the *same site*: SameSite cookies protect
nothing between them, and the content host counts as a same-site attacker. Nothing here relies on SameSite. The local
test hosts are same-site too (`app.localtest.me` / `content.localtest.me`; the browser reports `Sec-Fetch-Site:
same-site` for the frame request, tested).

**Who is who** (`identify()` in `index.ts`; the tailnet header is *not* identity):
- **Owner:** a session cookie `__Host-session` with subject `owner`, minted only by `POST /api/signin/owner` (the
  `/signin` page's button). That route needs `Origin == APP_ORIGIN` and the tailnet header: `Tailscale-User-Login` in
  `OWNER_LOGINS` and **no** `Tailscale-Funnel-Request`. Tailscale v1.104.7 `ipn/ipnlocal/serve.go`
  (`addTailscaleIdentityHeaders`) deletes client-sent copies of both headers, sets `Tailscale-Funnel-Request: ?1` on public
  (Funnel) traffic and the login only for tailnet users (not for tagged nodes); the marker check is defence in depth.
  Tailscale attaches the header to every request from the owner's devices, which is why it counts nowhere else.
  **On Funnel traffic an owner session counts as not signed in** (`identify()`, the one place): no owner actions, no
  reads, no rooms; the shell shows "not signed in" (R1).
- **Agent (pi):** `Authorization: Bearer <AGENT_TOKEN>` → identity `agent`: list, details, publish, the MCP endpoint, and
  its gated view of each comments room (see *Comments and pi*); nothing else; refused entirely on Funnel traffic.
- **Guest:** passkey (WebAuthn, `@simplewebauthn/server` 14.1, discoverable credential, rp = app host) registered through a
  one-use invite link (14 days; only the registration whose `UPDATE` marks the invite used gets the grant, R8). Ceremonies
  in progress are rows in `challenges`: expired rows go on every insert and at most 1,000 stay pending (the oldest make
  room, R5), since anyone can start one; the same `__Host-session` cookie with subject `g:<id>` (HttpOnly, Secure,
  SameSite=Lax, host-only, 30 days, stored hashed). A signed-in guest accepts further invites without a new passkey.
- **Link viewer:** no identity at all: the link token (`?k=`, 32 chars) on every request; **views only** (the owner's spec): a read-only room socket, no tools, no comments (R10); app-room writes only while the owner's per-page switch is on (R11). The same holds for a signed-in guest who opens a page
  through its link without a grant for it; invited guests on a link-mode page keep writing. Every sharing change makes a new token (valid as a link only in `link` mode), so a revoked
  link stays dead and old file URLs end with it (R2).
- **After sign-in** the shell returns only to a `return` URL whose resolved origin is the app's own (R6).

**What each may do** (`Platform.access()`): owner and agent see everything; `invited` → also guests with a grant;
`link` → also anyone presenting the link token, to view only (no room writes unless the owner's switch is on (R11), no tools, no comments; R10; invited guests keep
writing and their tools); `private` → owner (and agent) only. No
access answers 404 (existence is not revealed). Owner tools run only their pinned arguments (`args` in the manifest);
any arguments from the page are refused (`args_pinned`).

**Trust boundary: celld must only be reachable through tailscaled.** Anyone who can send requests to celld directly can
forge the identity header at the sign-in route. Prod publishes no host port; the only other client of
`artifacts-app:8080` is the usercontent container's tailscaled. Local mode publishes `127.0.0.1:8341` for the tests (the
test proxy plays tailscale serve, including TLS).

**Cross-origin writes (CSRF / cross-site WebSocket):** every non-GET request and every WebSocket handshake on the app host
must carry `Origin == APP_ORIGIN` (or no Origin: a non-browser client, which holds no ambient credential) and no
`Sec-Fetch-Site` other than `same-origin`/`none` (so `same-site`, i.e. a request from the content host, is refused
too). GET routes have no side effects. `Referrer-Policy: no-referrer` on every response of both hosts.

**The artifact sandbox:** `/v/<artifact>` embeds `<iframe sandbox="allow-scripts allow-same-origin" referrerpolicy="no-referrer">`
from the content host (another origin; same site in production, see above).
- Content CSP: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;
  connect-src 'none'; frame-ancestors <app>; form-action 'none'; base-uri 'none'; object-src 'none'; frame-src 'none';
  child-src 'none'; worker-src 'none'; manifest-src 'none'`. Tested: `fetch` (same origin, app host, a canary host), WebSocket and an image
  from the canary are blocked; the canary logs nothing. XHR, `sendBeacon` and foreign scripts fall under the same
  directives but were not tried separately.
- Shell CSP: `… frame-src <content origin>; connect-src 'self'; frame-ancestors 'none' …`. **`frame-src` also governs
  navigations of the child frame**, so a frame that navigates itself to any other origin (a canary, or the app host) is
  blocked before the request leaves the browser (Chrome: "Framing '…' violates … frame-src").
- Sandbox: no popups, no top navigation, no form submission. Artifacts must not use `<form>` submission (the ported list
  uses a button + Enter).
- No cookies: the session cookie is HttpOnly, host-only on the app host and `__Host-` prefixed, so content-host JS can
  neither read it nor set or shadow it (a `__Host-` cookie cannot carry `Domain`); the content host never reads identity.
  Tested on same-site hosts: seven read/set/shadow attempts, including cookies for the shared parent domain. Those do
  reach the app host (`session`, `__Secure-session`), but none can be or replace `__Host-session`, and the app ignores
  them. The Worker reads only a cookie named exactly `__Host-session`, at the start or after `; ` (R9).
- The SDK is the only channel: after the SDK's `hello`, the shell hands the frame a private `MessagePort` and accepts
  exactly three requests on it: `room.send` (to the app room, stamped with this viewer's id by the server),
  `tools.call` (tool name URL-encoded into `/api/tools/<artifact>/<tool>`; the server checks the manifest) and
  `comment.pick` (only in comment mode: text and box pre-fill a composer the viewer must still send; comment pins). Anything else is dropped. There is no path from the artifact to the comments room.

**MCP egress (chunk 3):** the only outbound network code is the Platform's MCP client. Its one `fetch` (`gatewayFetch`) allows
exactly the configured origins of the server being called (its URL's origin + `oauthOrigins`) and never follows redirects
(`redirect: "manual"`; the SDK refuses a cross-origin redirect). Tested: a configured server whose OAuth metadata names another
origin, and one that redirects everything there, reach nothing off the list (`egress-denied` event + log line); negative
control: without the check the off-list origin is contacted. Artifacts still have no network at all (content CSP).
**Tokens** never reach the shell or the artifact: the page gets tool results only; no route returns a token. At rest they are
sealed with a key from a secret file that is not in the data volume (grep of the volume for the known test tokens finds
nothing; the same grep finds the artifact's name, and finds a token with encryption patched out).
**OAuth callback** is the one GET with an effect; it completes only a flow started by the same signed-in subject (`state`
bound to the row, 10 min, single use).

**W3c cross-viewer attack:** its C1 half (an artifact *server* stashing one viewer's capability and using it in another
viewer's request) has nothing to run against: v1 has no artifact server code. Its C3 half (artifact JS calling platform
endpoints as the viewer) is tested: CSP blocks the calls (negative control: without the content CSP the fetches go
through), and a write arriving from the content origin *with* the viewer's session cookie is still refused by the Origin
check (tested with a direct request). In production the browser *does* attach the cookie to such a request (same
site), which is why the Origin check, not SameSite, is the guard.

## Residual risks (known, accepted or open)
1. **WebRTC exfiltration: the remaining residual channel.** No CSP directive governs `RTCPeerConnection`
   (`webrtc 'block'` had no effect in Chrome 157), and the sandbox does not block it. A CSP-locked artifact sent
   `SECRET-DATA-viewer-g123` as a TURN `USERNAME` to a UDP server it chose. Anything the artifact can see (room contents, the viewer's id and name, tool
   results in chunk 3: The owner's data for use case A, the viewer's data for B) can leave this way. A DNS variant
   (`stun:<data>.attacker.example`, data in the lookup) is likely too but **untested**.
   *What we rely on:* artifacts are written by the owner's own agents, not by strangers; the sandbox and CSP stop accidents
   and the common exfil paths, not a determined author. *What would close it:* no CSP directive exists. A hardened
   removal does **not** hold: CSP `frame-src`/
   `child-src`/`worker-src 'none'` plus a first script that deletes ~20 RTC globals non-restorably and scrubs child frames
   (patched `contentWindow`/`contentDocument` getters, a MutationObserver). Held: restoring the deleted global, `contentWindow`
   of a new frame, `data:`/`blob:` frames, workers, `window.open`, and a scan of all 1,240 `window` properties found no peer-connection
   constructor (only RTC event classes and `RTCRtpScriptTransform` remain, none can connect). **Bypassed,
   data arrived:** reading `window[i]` of a just-inserted `about:blank` frame (synchronous, before any observer runs; indexed
   frame access cannot be patched), and `document.write` into such a frame. Closing that would mean patching every DOM
   insertion path, an arms race. Closing it would need
   control outside the page. Untested ideas: a managed-browser policy that disables WebRTC (an IP-handling policy may
   not stop TURN to arbitrary servers), or not giving artifacts data worth stealing. **Accepted by the owner for use case B with
   invited guests, to revisit 🔁** (a leak needs a malicious page from his own agent).
2. **Same-origin self-navigation:** `frame-src` allows the frame to navigate within the content host, so data in such a URL
   reaches only the platform's own content host (404, not logged, not readable by artifacts); shown by a probe. Not a leak to a third party.
3. **celld 0.6.3 is not a hostile multi-tenant boundary** (W2a note). v1 runs only platform code, so this matters only if
   agent-written server code arrives later.
4. **Content capability URLs** are bearer links: anyone holding one can read that version's files (not the room) for up
   to 12 h, and only while that version is current and the sharing unchanged. They appear only in the shell page of a viewer
   with access. A file URL opened top-level serves no HTML or SVG (R7), but its JS/CSS/JSON/text answer as text.
5. **Owner identity depends on I4 (chunk 1, not yet run):** if tailnet requests to the Funnel name arrive without the
   login header, the owner needs the passkey fallback from the spec. Not built. Also unchecked: that the owner's tailnet
   devices reach the Funnel name over the tailnet (MagicDNS) and not through public ingress. Since R1 this decides all
   owner access, not only actions: a request from the owner's device that arrives as Funnel traffic is "not signed in".
6. **The local test hosts depend on public DNS** (`*.localtest.me` → loopback, someone else's zone). Global setup refuses
   to run unless both names resolve to `127.0.0.1`/`::1` only, so the tailnet marker and cookies cannot leak to another
   host; without DNS the suite cannot run. The real `*.ts.net` run (chunk 1 / 6) is still needed for Tailscale itself.
7. **All artifacts share the content origin and its storage** (spec): artifact A can read or plant data in B's
   `localStorage`/IndexedDB/cookies on the content host. It follows from the shared origin; not tested separately.
   Nothing of the platform is stored there.
8. **Room rate caps are per socket:** a viewer can open several sockets to get more than 100 messages per 10 s. The
   total is capped (1 MiB per live room, R4), which turns the old growth problem into an availability one: **anyone who
   may write to a room (the owner, pi, invited guests; link visitors only while the owner's switch is on, R11) can fill it in seconds, and then
   nobody can write until the owner rolls back** (accepted, R4). The comments room likewise (invited
   guests). No per-identity limit across sockets (brief). celld 0.6.3
   closes a refused socket at once, so a client still sending megabytes may see 1006 instead of 4009 (nothing is stored).
9. **A forwarded guest comment is a prompt for pi.** the owner's forward is the only gate; the text reaches pi as a user
   message (quoted, labelled "by a guest, forwarded by the owner"). The agent token sits in pi's environment, where any tool
   pi runs can read it (it works only from the tailnet).
10. **pi delivery is at least once, per install:** a crash between injecting and saving the seq re-delivers; two pi
   sessions following the same artifact both receive a new comment. A session that has neither published nor followed an
   artifact gets none of its comments; following never stops another session (DECISIONS.md A3, A14).
11. **pi's socket learns that the comments room changed** (it gets a frame after every append, also a guest comment's),
   though not what changed.
12. **Containers on the Studio reach the owner's tailnet through the host.** A plain container under Docker Desktop on
   the host opened TCP 22 on other tailnet devices and the host itself via their 100.x addresses (probe). Joining the containers as tagged tailnet nodes does not change this: their traffic can leave through the
   host's Tailscale with the host's rights. The platform's own code is what runs in the container (artifacts run in
   browsers), so this matters on a server-side compromise (celld or platform code). Closing it needs egress filtering
   for the containers (e.g. no route to 100.64.0.0/10). **Accepted by the owner, to revisit 🔁**.

13. **One cookie from an artifact can sign a viewer out of the app host** (review F5, minor). An artifact on the content
   host sets a cookie with a non-ASCII byte for the parent domain both hosts share; celld 0.6.3 then drops the whole
   `Cookie` header before the Worker sees it, so the viewer looks signed out until they delete that cookie by hand. The Worker cannot repair it. Closed
   structurally only by a content origin that cannot set cookies for the app host (an opaque-origin iframe or another
   registrable domain); upstream bug report filed: [denoland/celld#327](https://github.com/denoland/celld/issues/327).

14. **Any program or container on the owner's devices can sign in as owner** (review F1). The owner sign-in trusts the tailnet
   identity header, and every process on the host (pi, other containers, other user accounts) reaches the platform as
   the owner's device. So "pi is never owner" and the guest-comment forward gate are conventions, not enforced. **Accepted by
   the owner, to revisit 🔁**: agents overstepping and prompt injection are out of his threat model; the closing
   option is an owner passkey.
15. **A flood of anonymous sign-in starts** (`POST /api/signin/options`, ~1,000 per ceremony's duration) ends other
   people's passkey ceremonies in progress ("sign-in attempt expired, try again") while it lasts; it stores nothing beyond
   1,000 rows (R5).

16. **Tool data and WebRTC (chunk 3 makes 1. concrete):** a page that receives the owner's data (use case A) or a viewer's own data
   (B) can send it out over WebRTC. What limits it: The owner approves every version with viewer tools or new owner queries (and
   sees its tools), viewers consent per version, and pages come from the owner's agents.
17. **The approval gate reviews tool lists, not code:** a version with only unchanged owner queries is approved at publish, so
    new code can show the same owner data differently (e.g. send it over WebRTC). Viewer-tool pages always wait for approval.
18. **A configured server is trusted with what it returns** (tool results go to the page as is; `readOnlyHint` is the server's
    own claim).
19. **celld's memory grows with the artifacts opened since the last restart.** celld 0.6.3 keeps every touched Durable Object
    resident (idle eviction is off unless `CELLD_IDLE_EVICT_S` is set) and restarts the cells that were resident at shutdown. Near
    the container's limit it sheds: RPCs fail with `CapacityExhausted` after 15 s and the platform answers 500. Measured locally
    (1 GiB): one test run on a fresh volume peaks at about 735 MiB; each further run on the same volume starts higher (204 → 375
    → 425 MiB); one run shed and failed 6 tests. `CELLD_IDLE_EVICT_S=60` did not keep back-to-back runs flat, and a jump of 300–400 MiB
    early in each run is unexplained. **Every stack now gets 2 GiB** (one `MEM` in `scripts/stack.sh`; the numbers above are
    from 1 GiB). A restart does not free the resident set (celld restarts the cells resident at shutdown); it helps only after
    idle cells were evicted (an idle restart booted 0 cells). Open: the cause of the jump, and whether idle eviction belongs in prod.
20. **One vote per phone is best effort** (R11). A link visitor who may write has no identity: its id is a hash of a cookie
    the platform sets, so clearing cookies, a private window, a second browser or a raw socket without the cookie (an id per
    socket) each count as a new voter, and nothing limits how many. Writes stay capped per socket and per room (residual 8):
    while the switch is on, anyone with the link can fill the room and stop the poll until the owner rolls back. Measured by the review: one script fills a poll room in ~9 s, adding ~82 MB of disk per fill; each rollback allows another fill. The owner accepted this without a per-connection write cap ("overengineered"); fallback on stage: show of hands. Pages should
    count the last message per `from` and treat totals as indicative. Accepted for the stage demo (the owner's decision).
