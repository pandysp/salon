// Link visitors view only (R10). DoD 2: identity and sharing. Owner = tailnet header at the sign-in route
// (via the test proxy, which behaves like tailscale serve), guests = passkeys from invite links (Chrome virtual authenticator).
import http from "node:http";
import { test, expect } from "@playwright/test";
import { APP, CONTENT, OWNER_LOGIN, OWNER_NAME, UPSTREAM_PORT, uniq, publish, bundle, ownerApi, agentApi, ownerSession, ownerContext, inviteGuest, authenticator, tailnet, frame, note, EVIDENCE } from "./support/env.mjs";

const results = {};
const B64U = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
test.afterAll(() => note("dod2-identity.json", results));
const me = (headers = {}) => fetch(APP + "/api/me", { headers }).then((r) => r.json());

test("tailnet owner signs in without a login; the header alone is not identity anywhere else", async ({ browser }) => {
  // the owner's browser: the tailnet header is on every request, but he is "not signed in" until the sign-in route mints his session
  const ctx = await browser.newContext({ extraHTTPHeaders: tailnet() }), p = await ctx.newPage();
  await p.goto(APP + "/");
  await expect(p.getByTestId("viewer")).toHaveText("not signed in");
  results.headerOnlyMe = await p.evaluate(() => fetch("/api/me").then((r) => r.json()));
  expect(results.headerOnlyMe.kind).toBe("public");
  await p.goto(APP + "/signin");
  await p.getByTestId("signin-owner").click();
  await p.waitForURL(APP + "/");
  await expect(p.getByTestId("viewer")).toHaveText(`${OWNER_NAME} (owner)`);
  results.ownerMe = await p.evaluate(() => fetch("/api/me").then((r) => r.json()));
  expect(results.ownerMe).toEqual({ kind: "owner", id: "owner", name: OWNER_NAME });
  const c = (await ctx.cookies(APP)).find((x) => x.name === "__Host-session");
  expect(c).toMatchObject({ httpOnly: true, secure: true, sameSite: "Lax", domain: new URL(APP).hostname, path: "/" });
  await p.screenshot({ path: `${EVIDENCE}/dod2-owner-home.png` });
  await ctx.close();
});

test("a public request with a forged Tailscale-User-Login is not the owner and reaches no owner action", async ({ browser }) => {
  const name = uniq("forge");
  await publish(name, "artifacts/shared-list", "f1");
  const forged = { "tailscale-user-login": OWNER_LOGIN, "tailscale-user-name": "Andy" };
  // a browser on the public internet that sets the header itself, and tries the owner sign-in
  const pc = await browser.newContext({ extraHTTPHeaders: forged }), p = await pc.newPage();
  await p.goto(APP + "/signin");
  await p.getByTestId("signin-owner").click();
  await expect(p.getByTestId("signin-error")).toHaveText(`Owner sign-in works only from ${OWNER_NAME}'s tailnet.`);
  await p.goto(`${APP}/v/${name}`);
  await expect(p.getByTestId("noaccess")).toBeVisible();
  await pc.close();
  const post = (path, body, h = {}) => fetch(APP + path, { method: "POST", headers: { ...forged, origin: APP, "content-type": "application/json", ...h }, body: JSON.stringify(body) }).then((r) => r.status);
  const get = (path) => fetch(APP + path, { headers: forged }).then((r) => r.status);
  results.forgedOwnerActions = {
    me: await me(forged),
    signinOwner: await post("/api/signin/owner", {}),
    details: await get(`/api/artifacts/${name}`),
    publish: await post(`/api/artifacts/${name}/versions`, { manifest: {}, files: { "index.html": "pwned" } }),
    sharing: await post(`/api/artifacts/${name}/sharing`, { mode: "link" }),
    invite: await post(`/api/artifacts/${name}/invites`, { label: "attacker" }),
    rollback: await post(`/api/artifacts/${name}/rollback`, { version: 1 }),
    archive: await get(`/api/artifacts/${name}/archive`),
    events: await get("/api/events"),
    list: await fetch(APP + "/api/artifacts", { headers: forged }).then((r) => r.json()),
  };
  const f = results.forgedOwnerActions;
  expect(f.me.kind).toBe("public");
  for (const k of ["signinOwner", "details", "publish", "sharing", "invite", "rollback", "archive", "events"]) expect(f[k], k).toBe(403);
  expect(f.list).toEqual([]);
  // a real owner session used from the public internet (cookie stolen or the owner off the tailnet): owner actions refused
  results.ownerCookieViaFunnel = await fetch(APP + `/api/artifacts/${name}/sharing`, { method: "POST", headers: { cookie: await ownerSession(), origin: APP, "content-type": "application/json" }, body: '{"mode":"link"}' }).then((r) => r.status);
  expect(results.ownerCookieViaFunnel).toBe(403);
  expect((await ownerApi(`/api/artifacts/${name}`)).body).toMatchObject({ sharing: "private", current_version: 1 }); // nothing changed
  // defence in depth inside the Worker: even if a forged login reached celld, the Funnel marker that tailscale sets on public
  // traffic keeps the sign-in from minting a session (direct to celld, bypassing the proxy)
  results.forgedWithFunnelMarker = await new Promise((resolve, reject) => {
    const q = http.request({ host: "127.0.0.1", port: UPSTREAM_PORT, path: "/api/signin/owner", method: "POST",
      headers: { host: new URL(APP).host, origin: APP, ...forged, "tailscale-funnel-request": "?1" } }, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => resolve({ status: r.statusCode, body: d })); });
    q.on("error", reject); q.end();
  });
  expect(results.forgedWithFunnelMarker.status).toBe(403);
});

test("cross-origin requests from Andy's own browser are refused (CSRF, cross-site WebSocket, login CSRF)", async () => {
  const name = uniq("csrf");
  await publish(name, "artifacts/shared-list", "c1");
  const cookie = await ownerSession();
  results.csrf = {};
  for (const o of [CONTENT, "https://evil.example"]) {
    results.csrf[o] = {
      sharing: (await ownerApi(`/api/artifacts/${name}/sharing`, { mode: "link" }, { origin: o })).status,
      publish: (await ownerApi(`/api/artifacts/${name}/versions`, { manifest: {}, files: { "index.html": "x" } }, { origin: o })).status,
      ownerSignin: await fetch(APP + "/api/signin/owner", { method: "POST", headers: { ...tailnet(), origin: o } }).then((r) => r.status),
    };
    expect(results.csrf[o]).toEqual({ sharing: 403, publish: 403, ownerSignin: 403 });
  }
  results.csrf.secFetchSiteCrossSite = (await ownerApi(`/api/artifacts/${name}/sharing`, { mode: "link" }, { "sec-fetch-site": "cross-site" })).status;
  expect(results.csrf.secFetchSiteCrossSite).toBe(403);
  const ws = (origin) => new Promise((r) => {
    const s = new WebSocket(`${APP.replace("http", "ws")}/api/rooms/${name}/app`, { headers: { origin, cookie, ...tailnet() } });
    s.onopen = () => { s.close(); r("OPEN"); }; s.onerror = () => r("refused");
  });
  results.csrf.websocket = await ws("https://evil.example");
  results.csrf.websocketFromContent = await ws(CONTENT);
  results.csrf.websocketControl = await ws(APP); // the same handshake from the app opens, so "refused" came from the Origin check
  expect([results.csrf.websocket, results.csrf.websocketFromContent, results.csrf.websocketControl]).toEqual(["refused", "refused", "OPEN"]);
  expect((await ownerApi(`/api/artifacts/${name}/sharing`, { mode: "invited" })).status).toBe(200); // control
});

test("pi's bearer token acts as agent, not owner", async () => {
  const name = uniq("agent");
  results.agent = { me: (await agentApi("/api/me")).body };
  expect(results.agent.me).toEqual({ kind: "agent", id: "agent", name: "pi" });
  results.agent.publish = await publish(name, "artifacts/shared-list", "by agent", agentApi); // throws unless 200
  results.agent.list = (await agentApi("/api/artifacts")).status;
  results.agent.sharing = (await agentApi(`/api/artifacts/${name}/sharing`, { mode: "link" })).status;
  results.agent.invite = (await agentApi(`/api/artifacts/${name}/invites`, { label: "x" })).status;
  results.agent.rollback = (await agentApi(`/api/artifacts/${name}/rollback`, { version: 1 })).status;
  results.agent.events = (await agentApi("/api/events")).status;
  results.agent.wrongToken = (await agentApi("/api/me", undefined, "not-the-token")).status;
  results.agent.publishViaFunnel = (await agentApi(`/api/artifacts/${name}/versions`, await bundle("artifacts/shared-list", "x"), undefined, { viaFunnel: true })).status;
  results.agent.viewViaFunnel = (await agentApi(`/api/view/${name}`, undefined, undefined, { viaFunnel: true })).status;
  results.agent.listViaFunnel = (await agentApi("/api/artifacts", undefined, undefined, { viaFunnel: true })).status;
  expect(results.agent.publish.version).toBe(1);
  expect([results.agent.list, results.agent.sharing, results.agent.invite, results.agent.rollback, results.agent.events, results.agent.wrongToken, results.agent.publishViaFunnel, results.agent.viewViaFunnel, results.agent.listViaFunnel]).toEqual([200, 403, 403, 403, 403, 401, 403, 403, 403]);
  const ev = (await ownerApi(`/api/events?artifact=${name}`)).body.find((e) => e.kind === "publish");
  expect(ev.viewer).toBe("agent");
});

test("guest registers a passkey from an invite, signs in again later; invalid and used invites are refused", async ({ browser }) => {
  const name = uniq("guest"), other = uniq("guest2");
  await publish(name, "artifacts/shared-list", "g1");
  await publish(other, "artifacts/shared-list", "g2");
  await ownerApi(`/api/artifacts/${name}/sharing`, { mode: "invited" });
  await ownerApi(`/api/artifacts/${other}/sharing`, { mode: "invited" });

  const g = await inviteGuest(browser, name, "Greta");
  await expect(g.page.getByTestId("viewer")).toHaveText("Greta");
  await expect(frame(g.page).getByTestId("app-viewer")).toHaveText("Greta");
  const gme = await g.page.evaluate(() => fetch("/api/me").then((r) => r.json()));
  expect(gme.kind).toBe("guest");
  results.guestMe = gme;
  const sid = (await g.ctx.cookies(APP)).find((c) => c.name === "__Host-session");
  expect(sid).toMatchObject({ httpOnly: true, secure: true, sameSite: "Lax", domain: new URL(APP).hostname });
  results.sessionCookie = { ...sid, value: "<redacted>" };
  expect(await g.ctx.cookies(CONTENT)).toEqual([]); // host-only: never sent to the content host

  // the same invite link again (another browser): refused; a made-up one: refused
  const c2 = await browser.newContext(), p2 = await c2.newPage();
  await p2.goto(g.inviteUrl);
  await expect(p2.getByTestId("invite-error")).toHaveText("This invite link has already been used.");
  results.usedInviteApi = (await fetch(g.inviteUrl.replace("/invite/", "/api/invites/") + "/options", { method: "POST", headers: { origin: APP } })).status;
  expect(results.usedInviteApi).toBe(410);
  await p2.screenshot({ path: `${EVIDENCE}/dod2-used-invite.png` });
  await p2.goto(`${APP}/invite/not-a-real-token`);
  await expect(p2.getByTestId("invite-error")).toHaveText("This invite link is not valid.");
  await c2.close();

  // a signed-in guest accepts a second invite without a new passkey
  const inv2 = await ownerApi(`/api/artifacts/${other}/invites`, { label: "Greta again" });
  await g.page.goto(inv2.body.url);
  await g.page.getByTestId("invite-accept").click();
  await g.page.waitForURL(`${APP}/v/${other}`);
  await expect(frame(g.page).getByTestId("app-viewer")).toHaveText("Greta");

  // later: sign out, then sign in again on the same "device" (credentials restored into a new browser)
  const creds = await g.auth.credentials();
  expect(creds.length).toBe(1);
  await g.page.getByTestId("signout").click();
  await g.page.waitForURL(APP + "/");
  await g.page.goto(`${APP}/v/${name}`);
  await expect(g.page.getByTestId("noaccess")).toBeVisible();
  await g.ctx.close();
  const c3 = await browser.newContext(), p3 = await c3.newPage();
  await authenticator(p3, creds);
  await p3.goto(`${APP}/v/${name}`);
  await p3.getByTestId("signin-link").click();
  await p3.getByTestId("signin").click();
  await p3.waitForURL(`${APP}/v/${name}`);
  await expect(frame(p3).getByTestId("app-viewer")).toHaveText("Greta");
  results.signinAgain = await p3.evaluate(() => fetch("/api/me").then((r) => r.json()));
  expect(results.signinAgain.id).toBe(gme.id);
  await p3.screenshot({ path: `${EVIDENCE}/dod2-guest-signed-in-again.png` });
  await c3.close();
});

test("sharing: private, invited and link are enforced; artifact files need the current path token", async ({ browser }) => {
  const name = uniq("share"), other = uniq("share2");
  await publish(name, "artifacts/shared-list", "s1");
  await publish(other, "artifacts/shared-list", "s2");
  await ownerApi(`/api/artifacts/${name}/sharing`, { mode: "invited" });
  await ownerApi(`/api/artifacts/${other}/sharing`, { mode: "invited" });
  const g = await inviteGuest(browser, name, "Sam");
  const view = (n, k) => g.page.evaluate(([n, k]) => fetch(`/api/view/${n}${k ? "?k=" + k : ""}`).then((r) => r.status), [n, k]);
  results.sharing = { invitedGranted: await view(name), invitedNotGranted: await view(other) };
  await ownerApi(`/api/artifacts/${name}/sharing`, { mode: "private" });
  results.sharing.privateGranted = await view(name);
  await g.page.goto(`${APP}/v/${name}`);
  await expect(g.page.getByTestId("noaccess")).toBeVisible();
  const link = (await ownerApi(`/api/artifacts/${name}/sharing`, { mode: "link" })).body.url;
  const token = new URL(link).searchParams.get("k");
  expect(token.length).toBeGreaterThanOrEqual(32);
  const pc = await browser.newContext(), p = await pc.newPage(); // anyone, not signed in
  await p.goto(`${APP}/v/${name}`);
  await expect(p.getByTestId("noaccess")).toBeVisible();
  await p.goto(`${APP}/v/${name}?k=wrong`);
  await expect(p.getByTestId("noaccess")).toBeVisible();
  await p.goto(link);
  await expect(frame(p).getByTestId("status")).toHaveText("connected");
  // a link visitor views only (spec; R10): its socket receives the room, and any frame it sends closes it
  const linkSocket = (msgs) => p.evaluate(([n, k, m]) => new Promise((r) => {
    const s = new WebSocket(`wss://${location.host}/api/rooms/${n}/app?k=${k}`); let history = null;
    s.onmessage = (e) => { const x = JSON.parse(e.data); if (x.type === "history") { history = x.messages.length; for (const y of m) s.send(JSON.stringify(y)); if (!m.length) s.close(); } };
    s.onclose = (e) => r({ history, code: e.code, reason: e.reason });
  }), [name, token, msgs]);
  results.sharing.linkWrite = await linkSocket([{ type: "probe", from: "owner" }]);
  expect(results.sharing.linkWrite).toEqual({ history: 0, code: 4003, reason: "view only" });
  // having opened the link once gives nothing: the link token is needed on each request
  results.sharing.anonWithoutToken = await p.evaluate((n) => fetch(`/api/view/${n}`).then((r) => r.status), name);
  results.sharing.anonWsWithoutToken = await p.evaluate((n) => new Promise((r) => { const s = new WebSocket(`wss://${location.host}/api/rooms/${n}/app`); s.onopen = () => r("OPEN"); s.onerror = () => r("refused"); }), name);
  await frame(p).getByTestId("new-item-input").fill("from a link visitor"); await frame(p).getByTestId("new-item-input").press("Enter");
  await p.waitForTimeout(500);
  await expect(frame(p).getByTestId("item-title")).toHaveCount(0); // the shell drops it, the room would refuse it
  results.sharing.storedAfterUi = (await linkSocket([])).history;
  expect(results.sharing.storedAfterUi).toBe(0);
  await expect(p.getByTestId("comments")).toHaveCount(0);
  expect(await pc.cookies()).toEqual([]); // no cookie at all for a link viewer

  // path tokens: the current one works; a forged one, none, and the previous version's one are refused
  const src = await p.locator('[data-testid="artifact-frame"]').getAttribute("src");
  const cap = decodeURIComponent(src.split("/c/")[1].split("/")[0]);
  const st = (u) => fetch(u, { headers: { "sec-fetch-dest": "iframe" } }).then((r) => r.status); // as the shell's frame loads it (review F8)
  results.sharing.content = {
    current: await st(src),
    // forge a MAC character in the middle (the last one also carries padding bits)
    forged: await st(`${CONTENT}/c/${encodeURIComponent(cap.slice(0, -10) + (cap.at(-10) === "A" ? "B" : "A") + cap.slice(-9))}/index.html`),
    // same MAC bytes, other spelling: flip a padding bit of the last char (in the base64url alphabet)
    padding: await st(`${CONTENT}/c/${encodeURIComponent(cap.slice(0, -1) + B64U[B64U.indexOf(cap.at(-1)) ^ 1])}/index.html`),
    none: await st(`${CONTENT}/c//index.html`),
    nameOnly: await st(`${CONTENT}/c/${name}/index.html`),
  };
  await publish(name, "artifacts/shared-list", "s1 v2");
  results.sharing.content.previousVersion = await st(src);
  expect(results.sharing).toMatchObject({ invitedGranted: 200, invitedNotGranted: 404, privateGranted: 404, anonWithoutToken: 404, anonWsWithoutToken: "refused",
    content: { current: 200, forged: 404, padding: 404, none: 404, nameOnly: 404, previousVersion: 404 } });
  await pc.close(); await g.ctx.close();
});
