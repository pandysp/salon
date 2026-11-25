// Part 1: the review's attacks, one test per fixed finding, with each assert FLIPPED: a test passes when the attack is refused.
// Changes beyond the flip are only what a fix forces (marked "adapted:"). F1 and F5 are not fixed here, so their attacks are
// not copied. Part 2: one test per guard that the review's attacks do not reach (needed for its negative control).
// The proof that each fix is what makes its test pass: tests/negative-controls.sh (one control per guard).
import { test, expect } from "@playwright/test";
import { APP, CONTENT, STACK_NAME, ROOT, stackRunning, stackRestarts, uniq, publish, ownerApi, agentApi, ownerSession, ownerContext, inviteGuest, authenticator, tailnet, frame, note, EVIDENCE, openShare, openComments } from "./support/env.mjs";
import path from "node:path";
import { mcpClient } from "./support/pi-harness.mjs";
import https from "node:https"; // B1 (pre-Funnel review): raw Content-Length vs chunked bodies
import { execFileSync } from "node:child_process";

// adapted: results go to the untracked run evidence (tests/support/env.mjs note())
const save = (finding, r) => note(`review-${finding}.json`, r);
const wss = (o) => o.replace(/^http/, "ws");
// adapted: resolves as soon as the server closes the socket (closed = its code), else after `ms` (closed = null); "refused" =
// no upgrade. The review's version waited the full `ms` and could miss a close that came after it.
const sock = (url, headers, msgs = [], ms = 800) => new Promise((resolve) => {
  const ws = new WebSocket(url, { headers }), frames = []; let opened = false, timer;
  const done = (closed) => { clearTimeout(timer); resolve({ opened, frames, closed }); };
  ws.onopen = () => { opened = true; for (const m of msgs) ws.send(JSON.stringify(m)); timer = setTimeout(() => { ws.onclose = null; ws.close(); done(null); }, ms); };
  ws.onmessage = (e) => frames.push(JSON.parse(e.data));
  ws.onclose = (e) => done(e.code);
  ws.onerror = () => { if (!opened) done("refused"); };
});
const guestComment = async (page, text) => { await openComments(page); /* shell restyle: collapsed by default */ await page.getByTestId("comment-input").fill(text); await page.getByTestId("comment-send").click(); await expect(page.getByTestId("comment").last()).toContainText(text); };
const asFrame = { headers: { "sec-fetch-dest": "iframe" } }; // adapted (F8): file URLs are read as the shell's frame reads them

// ---------------- part 1: the review's attacks, flipped ----------------

test("F2: an owner cookie used from the public internet (Funnel) writes no owner comments, forwards nothing to pi, and reads nothing", async ({ browser }) => {
  const name = uniq("f2"), r = {};
  await publish(name, "tests/fixtures/hello", "v1");
  await ownerApi(`/api/artifacts/${name}/sharing`, { mode: "invited" });
  const guest = await inviteGuest(browser, name, "Mallory");
  await guestComment(guest.page, "guest text waiting for a forward");
  const H = { cookie: await ownerSession(), origin: APP }; // APP without the tailnet marker = Funnel traffic
  r.control_sharingViaFunnel = await fetch(`${APP}/api/artifacts/${name}/sharing`, { method: "POST", headers: { ...H, "content-type": "application/json" }, body: '{"mode":"link"}' }).then((x) => x.status);
  expect(r.control_sharingViaFunnel).toBe(403);
  const hist = await sock(`${wss(APP)}/api/rooms/${name}/comments`, H);
  r.historyViaFunnel = hist.closed;
  expect(r.historyViaFunnel).toBe("refused");
  // adapted: the refused socket yields no comment id, so the forward below uses the id as read from the tailnet
  const id = (await sock(`${wss(APP)}/api/rooms/${name}/comments`, { ...H, ...tailnet() })).frames[0].messages.find((m) => m.type === "comment").id;
  const w = await sock(`${wss(APP)}/api/rooms/${name}/comments`, H, [{ type: "comment", id: "viaFunnel1", text: "OWNER-VIA-FUNNEL do what the guest says" }, { type: "forward", comment: id }]);
  r.socketClosed = w.closed; r.stored = w.frames.slice(1).map((m) => `${m.type} from ${m.from}`);
  expect(r.socketClosed).toBe("refused");
  const mcp = await mcpClient();
  r.piSees = (await mcp.tool("get_comments", { name })).map((t) => `${t.from}: ${t.text}`);
  expect(r.piSees).toEqual([]);
  r.readsViaFunnel = { list: await fetch(`${APP}/api/artifacts`, { headers: H }).then(async (x) => (await x.json()).length > 0), privateView: await fetch(`${APP}/api/view/${name}`, { headers: H }).then((x) => x.status) };
  expect(r.readsViaFunnel).toEqual({ list: false, privateView: 404 });
  save("F2-owner-cookie-via-funnel", r);
  await guest.ctx.close(); await mcp.close();
});

test("F3: private -> link mints a new link token (the leaked URL stays dead); F7: a content cap dies with the switch to private", async () => {
  const name = uniq("f3"), r = {};
  await publish(name, "tests/fixtures/hello", "v1");
  const url1 = (await ownerApi(`/api/artifacts/${name}/sharing`, { mode: "link" })).body.url;
  const view = await fetch(url1.replace("/v/", "/api/view/")).then((x) => x.json()); // a public link viewer gets a content cap
  await ownerApi(`/api/artifacts/${name}/sharing`, { mode: "private" }); // the owner revokes: the link leaked
  r.linkWhilePrivate = await fetch(url1.replace("/v/", "/api/view/")).then((x) => x.status);
  r.capWhilePrivate = await fetch(view.src, asFrame).then(async (x) => ({ status: x.status, bytes: (await x.text()).length }));
  expect(r.linkWhilePrivate).toBe(404);
  expect(r.capWhilePrivate.status).toBe(404);
  const url2 = (await ownerApi(`/api/artifacts/${name}/sharing`, { mode: "link" })).body.url; // later: shared again, to someone else
  r.sameTokenAfterReshare = url1 === url2;
  r.leakedLinkWorksAgain = await fetch(url1.replace("/v/", "/api/view/")).then((x) => x.status);
  expect(r.sameTokenAfterReshare).toBe(false);
  expect(r.leakedLinkWorksAgain).toBe(404);
  r.agentReadsLinkToken = typeof (await agentApi(`/api/artifacts/${name}`)).body.link_token;
  expect(r.agentReadsLinkToken).toBe("undefined");
  save("F3-link-token-rotated_F7-cap-dies-with-private", r);
});

test("F6: no open redirect after sign-in (/signin?return=/\\host lands on the app)", async ({ browser }) => {
  const ctx = await browser.newContext({ extraHTTPHeaders: { "x-test-tailnet": process.env.TAILNET_TEST_SECRET } }), p = await ctx.newPage();
  await ctx.route("https://exfil.example/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "attacker page" }));
  await p.goto(`${APP}/signin?return=/%5Cexfil.example/phish`);
  await p.getByTestId("signin-owner").click();
  await p.waitForURL((u) => u.pathname !== "/signin"); // adapted: wait for whichever page comes next
  expect(p.url()).toBe(`${APP}/`);
  save("F6-open-redirect", { start: `${APP}/signin?return=/%5Cexfil.example/phish`, landedOn: p.url() });
  await ctx.close();
});

test("F4: a room cannot grow without limit: the cap holds across reconnects (1 MiB per room)", async ({ browser }) => {
  const name = uniq("f4"), r = {};
  await publish(name, "tests/fixtures/hello", "v1");
  // adapted (R10, link visitors view only): the writer is an invited guest, not an anonymous link viewer
  await ownerApi(`/api/artifacts/${name}/sharing`, { mode: "invited" });
  const guest = await inviteGuest(browser, name, "Flooder");
  const G = { cookie: `__Host-session=${(await guest.ctx.cookies(APP)).find((c) => c.name === "__Host-session").value}`, origin: APP };
  // adapted: the review's (a) half (2,000 anonymous sign-in starts, all 200) is left out: the fix bounds the stored rows rather
  // than refusing calls, so its assert cannot be flipped; part 2 "F4b eviction"
  // (b) a writer: 95 x 60 KB per socket stays under the per-socket cap; a new socket starts a new window
  const big = { type: "x", pad: "A".repeat(60_000) };
  const t0 = Date.now(), runs = [];
  for (let i = 0; i < 2; i++) runs.push(await sock(`${wss(APP)}/api/rooms/${name}/app`, G, Array.from({ length: 95 }, () => big), 1500));
  r.flood = { sockets: runs.length, closedByServer: runs.map((x) => x.closed), ms: Date.now() - t0 };
  const h = await sock(`${wss(APP)}/api/rooms/${name}/app`, G, [], 1500);
  r.flood.storedMessages = h.frames[0].messages.length;
  r.flood.historyFrameBytes = Buffer.byteLength(JSON.stringify(h.frames[0])); // adapted: bytes, not rounded MB, to compare with the cap
  expect(r.flood.storedMessages).toBeGreaterThan(10); // the guest's writes did land: the room filled up to the cap
  expect(r.flood.storedMessages).toBeLessThan(190);
  expect(r.flood.historyFrameBytes).toBeLessThanOrEqual(1024 * 1024); // the review measured 11.4 MB
  // adapted: the per-socket close codes are recorded, not asserted: celld closes a refused socket at once, and a client still
  // sending megabytes then loses the close frame (1006) or sees none; what counts is what the room stored
  save("F4-bounded-storage", r);
  await guest.ctx.close();
});

test("F8: a content cap URL opened top-level does not run: no unsandboxed navigation with stashed viewer data", async ({ browser }) => {
  const name = uniq("f8"), r = {};
  await publish(name, "tests/fixtures/toplevel", "v1"); // the review's fixture
  const oc = await ownerContext(browser), p = await oc.newPage();
  let leak = null;
  await oc.route("https://exfil.example/**", (route) => { leak = route.request().url(); route.fulfill({ status: 200, contentType: "text/html", body: "got it" }); });
  await p.goto(`${APP}/v/${name}`);
  await expect(frame(p).locator("#out")).toHaveText("stashed");
  r.inFrameLeak = leak; // inside the shell nothing leaves
  const src = await p.evaluate((n) => fetch(`/api/view/${n}`).then((x) => x.json()).then((v) => v.src), name);
  const res = await p.goto(src); // the same URL as a top-level page (a link someone sends, or "open frame in new tab")
  await p.waitForTimeout(500); // adapted: no navigation to wait for once the page does not run
  r.topLevelStatus = res.status();
  r.topLevelLeak = leak;
  expect(r.inFrameLeak).toBe(null);
  expect(r.topLevelStatus).toBe(403);
  expect(r.topLevelLeak).toBe(null);
  save("F8-cap-url-top-level", r);
  await oc.close();
});

// ---------------- part 2: guards the review's attacks do not reach (one test each, for its negative control) ----------------

test("F4 rollback bound: a rollback that would put more than 1 MiB back in the room is refused; one that fits works", async () => {
  const MAX = 1024 * 1024, name = uniq("f4rb"), r = {};
  await publish(name, "tests/fixtures/hello", "v1");
  const H = { cookie: await ownerSession(), origin: APP, ...tailnet() }; // the owner fills the room (link visitors view only, R10)
  const room = `${wss(APP)}/api/rooms/${name}/app`, big = { type: "x", pad: "A".repeat(60_000) };
  const fill = async () => { for (let i = 0; i < 2; i++) await sock(room, H, Array.from({ length: 95 }, () => big), 5000); };
  const history = async () => Buffer.byteLength(JSON.stringify((await sock(room, H, [], 1000)).frames[0]));
  const ver = async (label) => (await publish(name, "tests/fixtures/hello", label)).version;
  await fill(); const v2 = await ver("v2");                                   // v2 records a full room
  r.toV1 = (await ownerApi(`/api/artifacts/${name}/rollback`, { version: 1 })).status; // empties it (archive)
  await fill(); const v4 = await ver("v4");                                   // full again; v4 would bring back both batches
  const before = await history();
  r.toV4 = (await ownerApi(`/api/artifacts/${name}/rollback`, { version: v4 })).status;
  r.unchanged = (await history()) === before;
  r.toV2 = (await ownerApi(`/api/artifacts/${name}/rollback`, { version: v2 })).status;
  r.afterV2Bytes = await history();
  expect(r).toMatchObject({ toV1: 200, toV4: 409, unchanged: true, toV2: 200 });
  expect(r.afterV2Bytes).toBeLessThanOrEqual(MAX);
  save("F4-rollback-bound", r);
});

test("F4b eviction: of 1,000 pending sign-in challenges the oldest makes room; one more flood pushes a ceremony out", async () => {
  const MAX = 1000, r = {};
  const start = () => fetch(`${APP}/api/signin/options`, { method: "POST" }).then(async (x) => (await x.json()).flow);
  const flood = async (n) => { for (let i = 0; i < n; i += 100) await Promise.all(Array.from({ length: Math.min(100, n - i) }, start)); };
  // a made-up passkey: 401 "unknown passkey" = the challenge was still stored; 400 "expired" = it was dropped
  const verify = (flow) => fetch(`${APP}/api/signin/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ flow, response: { id: "made-up" } }) })
    .then(async (x) => `${x.status} ${(await x.json()).error}`);
  const a = await start(); await flood(MAX - 1); r.oldestAtCap = await verify(a);
  const b = await start(); await flood(MAX); r.pushedOut = await verify(b);
  expect(r).toEqual({ oldestAtCap: "401 unknown passkey", pushedOut: "400 sign-in attempt expired, try again" });
  save("F4b-eviction", r);
});

test("F8 SVG: an SVG file URL opened top-level does not run either (it would, like a page); as an image it still loads", async ({ browser }) => {
  const name = uniq("f8svg"), r = {};
  await publish(name, "tests/fixtures/toplevel", "v1");
  const oc = await ownerContext(browser), p = await oc.newPage();
  let leak = null;
  await oc.route("https://exfil.example/**", (route) => { leak = route.request().url(); route.fulfill({ status: 200, contentType: "text/html", body: "got it" }); });
  await p.goto(`${APP}/v/${name}`);
  await expect(frame(p).locator("#out")).toHaveText("stashed");
  const svg = (await p.evaluate((n) => fetch(`/api/view/${n}`).then((x) => x.json()).then((v) => v.src), name)).replace(/index\.html$/, "page.svg");
  r.topLevelStatus = (await p.goto(svg)).status();
  await p.waitForTimeout(500);
  r.leak = leak;
  r.asImage = await p.evaluate((u) => new Promise((ok) => { const i = new Image(); i.onload = () => ok("loaded"); i.onerror = () => ok("error"); i.src = u; }), svg);
  expect(r).toEqual({ topLevelStatus: 403, leak: null, asImage: "loaded" });
  save("F8-svg-top-level", r);
  await oc.close();
});

test("invite race (hardening): four registrations on one invite at once: exactly one guest, one grant", async ({ browser }) => {
  const name = uniq("race"), r = {};
  await publish(name, "tests/fixtures/hello", "v1");
  await ownerApi(`/api/artifacts/${name}/sharing`, { mode: "invited" });
  const token = new URL((await ownerApi(`/api/artifacts/${name}/invites`, { label: "one person" })).body.url).pathname.split("/").pop();
  const racers = []; // four browsers run the ceremony on the same invite up to the verify; then all verify at once
  for (let i = 0; i < 4; i++) {
    const ctx = await browser.newContext(), p = await ctx.newPage();
    await authenticator(p);
    await p.goto(APP + "/");
    const ready = await p.evaluate(async (t) => {
      const { flow, options } = await (await fetch(`/api/invites/${t}/options`, { method: "POST" })).json();
      const cred = await navigator.credentials.create({ publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(options) });
      return { flow, response: cred.toJSON() };
    }, token);
    racers.push({ ctx, p, body: { ...ready, name: `racer ${i}` } });
  }
  r.statuses = await Promise.all(racers.map(({ p, body }) => p.evaluate(([t, b]) => fetch(`/api/invites/${t}/verify`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((x) => x.status), [token, body])));
  r.grants = (await ownerApi(`/api/events?artifact=${name}`)).body.filter((e) => e.kind === "invite-used").length;
  expect(r.statuses.slice().sort()).toEqual([200, 410, 410, 410]);
  expect(r.grants).toBe(1);
  save("invite-race", r);
  for (const { ctx } of racers) await ctx.close();
});

test("cookieOf (the final review's first F5 fix, R9): only a cookie named exactly __Host-session after \"; \" is the session", async () => {
  const r = {}, sid = (await ownerSession()).split("=")[1];
  const me = (cookie) => fetch(`${APP}/api/me`, { headers: { cookie, ...tailnet() } }).then((x) => x.json()).then((x) => x.kind);
  // a tab stands in for the review's Unicode spaces (celld 0.6.3 drops non-ASCII headers, a tab reaches the Worker)
  r.tabBeforeName = await me(`pref=1;\t__Host-session=${sid}`);
  r.plain = await me(`__Host-session=${sid}`);
  r.afterOther = await me(`pref=1; __Host-session=${sid}`);
  r.noSpace = await me(`pref=1;__Host-session=${sid}`);
  expect(r).toEqual({ tabBeforeName: "public", plain: "owner", afterOther: "owner", noSpace: "owner" });
  save("cookieOf", r);
});

test("R2 owner link read (lead's decision): Andy copies the live link again without ending it; the agent and Funnel traffic never see it", async ({ browser }) => {
  const name = uniq("r2"), r = {};
  await publish(name, "tests/fixtures/hello", "v1");
  const url = (await ownerApi(`/api/artifacts/${name}/sharing`, { mode: "link" })).body.url;
  const view = (u) => fetch(u.replace("/v/", "/api/view/")).then((x) => x.status); // a public link viewer
  r.ownerReads = [(await ownerApi(`/api/artifacts/${name}`)).body.link, (await ownerApi(`/api/artifacts/${name}`)).body.link];
  r.linkStillWorks = await view(url); // reading did not rotate it
  const agent = (await agentApi(`/api/artifacts/${name}`)).body;
  r.agentSees = { link: "link" in agent, token: JSON.stringify(agent).includes(new URL(url).searchParams.get("k")) };
  r.ownerViaFunnel = await fetch(`${APP}/api/artifacts/${name}`, { headers: { cookie: await ownerSession(), origin: APP } }).then((x) => x.status);
  const oc = await ownerContext(browser), p = await oc.newPage(); // the owner panel shows it on load
  await p.goto(`${APP}/v/${name}`);
  r.panel = await p.getByTestId("link-url").inputValue();
  await oc.close();
  await ownerApi(`/api/artifacts/${name}/sharing`, { mode: "private" });
  r.ownerReadsWhilePrivate = (await ownerApi(`/api/artifacts/${name}`)).body.link;
  expect(r).toEqual({ ownerReads: [url, url], linkStillWorks: 200, agentSees: { link: false, token: false }, ownerViaFunnel: 403, panel: url, ownerReadsWhilePrivate: null });
  save("R2-owner-link-read", r);
});

test("R10 link view only (Andy's spec): link visitors (no grant) get a read-only socket and no tools, also with a spoofed x-room-from or a guest session for another page; invited guests keep writing", async ({ browser }) => {
  const name = uniq("r10"), other = uniq("r10o"), r = {};
  await publish(name, "tests/fixtures/evil", "v1"); // only for its manifest: one owner tool
  // its owner query makes v1 wait for the owner's approval (T6, chunk 3); approve it so guests and link visitors see it (merged
  // the fixture's viewer tool and the visitorViewer probe:
  // DoD 6 would make this room read-only; visitorOwner shows view_only comes before the tool lookup)
  expect((await ownerApi(`/api/artifacts/${name}/versions/1/approve`, {})).status).toBe(200);
  await publish(other, "tests/fixtures/hello", "v1");
  for (const n of [name, other]) await ownerApi(`/api/artifacts/${n}/sharing`, { mode: "invited" });
  const invited = await inviteGuest(browser, name, "Ina");    // a grant on this page
  const elsewhere = await inviteGuest(browser, other, "Bo");  // signed in, but a grant only on another page
  const k = new URL((await ownerApi(`/api/artifacts/${name}/sharing`, { mode: "link" })).body.url).searchParams.get("k");
  const cookie = async (g) => ({ cookie: `__Host-session=${(await g.ctx.cookies(APP)).find((c) => c.name === "__Host-session").value}`, origin: APP });
  const room = `${wss(APP)}/api/rooms/${name}/app`, owner = { cookie: await ownerSession(), origin: APP, ...tailnet() };
  const write = await sock(`${room}?k=${k}`, {}, [{ type: "x", text: "from a link visitor" }], 3000);
  r.linkVisitor = { history: write.frames[0]?.type, closed: write.closed };
  r.spoofed = (await sock(`${room}?k=${k}`, { "x-room-from": "owner" }, [{ type: "x", text: "spoofed owner" }], 3000)).closed;
  r.guestWithoutGrant = (await sock(`${room}?k=${k}`, await cookie(elsewhere), [{ type: "x", text: "from Bo" }], 3000)).closed;
  r.invitedGuest = (await sock(`${room}?k=${k}`, await cookie(invited), [{ type: "x", text: "from Ina" }], 1000)).closed; // null: still open
  await sock(room, owner, [{ type: "x", text: "from Andy" }], 1000); // control: the owner writes too
  const tool = async (t, headers = {}) => fetch(`${APP}/api/tools/${name}/${t}?k=${k}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" }).then(async (x) => `${x.status} ${(await x.json()).error}`);
  r.tools = { visitorOwner: await tool("owner_query"), guestWithoutGrantOwner: await tool("owner_query", await cookie(elsewhere)) };
  // only this test's messages (type "x"): the evil fixture also writes while Ina's browser shows the page, as her
  r.stored = (await sock(`${room}?k=${k}`, {}, [], 1000)).frames[0].messages.filter((m) => m.type === "x").map((m) => `${m.from === "owner" ? "owner" : m.from.slice(0, 2)}: ${m.text}`);
  expect(r).toEqual({ linkVisitor: { history: "history", closed: 4003 }, spoofed: 4003, guestWithoutGrant: 4003, invitedGuest: null,
    tools: { visitorOwner: "403 view_only", guestWithoutGrantOwner: "403 view_only" },
    stored: ["g:: from Ina", "owner: from Andy"] });
  // the page learns it from viewer.kind ("link", no identity) and can hide its inputs; the invited guest stays a guest, and a
  // signed-in guest without a grant is a link visitor too (no name for the page)
  const pageViewer = async (page) => { const f = page.frames().find((x) => x.url().startsWith(CONTENT)); return f.evaluate(async () => (await window.artifact.ready).viewer); };
  const visitor = await browser.newContext(), vp = await visitor.newPage();
  for (const p of [vp, elsewhere.page]) { await p.goto(`${APP}/v/${name}?k=${k}`); await expect(frame(p).getByTestId("results")).not.toHaveText("running", { timeout: 20_000 }); }
  r.sdkViewer = { linkVisitor: await pageViewer(vp), guestWithoutGrant: await pageViewer(elsewhere.page), invitedGuest: (await pageViewer(invited.page)).kind };
  expect(r.sdkViewer).toEqual({ linkVisitor: { kind: "link", id: null, name: null, canWrite: false }, guestWithoutGrant: { kind: "link", id: null, name: null, canWrite: false }, invitedGuest: "guest" }); // canWrite: R11
  await visitor.close();
  save("R10-link-view-only", r);
  await invited.ctx.close(); await elsewhere.ctx.close();
});

// ---------------- pre-Funnel review ----------------

// B1 as a test. One anonymous POST of 200 MB (the crash point was ~150 MB) killed celld (V8 heap OOM) and
// with it the container. Passes when both forms of the body (Content-Length and chunked) get the platform's own 413, which a
// crashed celld cannot send (the proxy says 502), and a Docker stack's container never restarted (up.sh restarts it now, so
// liveness alone would hide a crash).
test("B1 body cap: a 200 MB anonymous POST (Content-Length or chunked) gets 413 and the platform stays up", async () => {
  test.setTimeout(180_000);
  const u = new URL(APP), MB = 200, chunk = "A".repeat(1 << 20), head = '{"flow":"x","response":"', tail = '"}';
  const attack = (chunked) => new Promise((resolve) => {
    const len = head.length + MB * chunk.length + tail.length;
    const req = https.request({ host: "127.0.0.1", port: u.port, servername: u.hostname, rejectUnauthorized: false, method: "POST", path: "/api/signin/verify",
      headers: { host: u.host, "content-type": "application/json", ...(chunked ? {} : { "content-length": len }) } }, (res) => {
      let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => resolve(`${res.statusCode} ${b.slice(0, 80)}`));
    });
    req.on("error", (e) => resolve(`request error: ${e.code ?? e.message}`));
    // Pause where a capped platform has answered (after the headers with Content-Length, after 9 MB chunked) and send the rest
    // only if it has not answered within 5 s. Sending on while the platform closes the upload raced the test proxy into a 502
    // (EPIPE before it read the 413); an uncapped platform still gets all 200 MB.
    let i = 0, answered = false, waited = false;
    req.on("response", () => (answered = true));
    req.write(head);
    const pause = chunked ? 9 : 0;
    const pump = () => {
      while (i < MB && !answered) {
        if (i === pause && !waited) { waited = true; return void setTimeout(pump, 5000).unref?.(); }
        i++; if (!req.write(chunk)) return req.once("drain", pump);
      }
      if (!answered) req.end(tail);
    };
    pump();
  });
  const r = { before: stackRestarts() };
  r.contentLength = await attack(false);
  r.chunked = await attack(true);
  r.me = (await fetch(`${APP}/api/me`)).status;
  r.after = stackRestarts();
  save("B1-body-cap", r);
  expect(r).toEqual({ before: r.before, contentLength: expect.stringMatching(/^413 .*request body over 8388608 bytes/),
    chunked: expect.stringMatching(/^413 .*request body over 8388608 bytes/), me: 200, after: r.before });
});

// S1: the reviewer's signin-flood.mjs, smaller. Every SQLite transaction leaves a celld log file (.ltx) that celld kept forever,
// and each anonymous POST /api/signin/options wrote one: 20,000 calls added 1,526 files and ~200 MB. Pending ceremonies now
// live in memory, so a flood writes nothing. Passes when 2,000 calls add no log file. Docker stack: the container's volume;
// native celld (negative controls): app/.celld.
test("S1 flood: 2,000 anonymous sign-in starts add no celld log file (pending ceremonies stay in memory)", async () => {
  test.setTimeout(120_000);
  const running = stackRunning();
  const ltx = () => Number((running ? execFileSync("docker", ["exec", STACK_NAME, "sh", "-c", "find /app/.celld -name '*.ltx' | wc -l"], { encoding: "utf8" })
    : execFileSync("sh", ["-c", "find app/.celld -name '*.ltx' | wc -l"], { cwd: ROOT, encoding: "utf8" })).trim());
  const start = () => fetch(`${APP}/api/signin/options`, { method: "POST" }).then((x) => x.status);
  const r = { where: running ? `docker volume of ${STACK_NAME}` : "app/.celld", before: ltx(), answered: 0 };
  for (let i = 0; i < 2000; i += 50) r.answered += (await Promise.all(Array.from({ length: 50 }, start))).filter((s) => s === 200).length;
  r.added = ltx() - r.before;
  save("S1-flood", r);
  expect(r).toMatchObject({ answered: 2000, added: 0 });
});

// ---------------- R11: "link visitors may write to the room" (the owner, for the stage poll) ----------------
// Decisions: docs/DECISIONS.md R11; controls in
// tests/negative-controls.sh (link-write-*, visitor-*, sharing-closes-sockets).
const linkWrite = (name, on, headers) => headers
  ? fetch(`${APP}/api/artifacts/${name}/link-write`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ on }) }).then((x) => x.status)
  : ownerApi(`/api/artifacts/${name}/link-write`, { on }).then((x) => x.status);
// a socket the test keeps open: frames as they come, `closed` = the close code once the server closes it
const keep = (url, headers = {}) => new Promise((resolve, reject) => {
  const ws = new WebSocket(url, { headers }), s = { ws, frames: [], closed: null, send: (m) => ws.send(JSON.stringify(m)) };
  ws.onmessage = (e) => s.frames.push(JSON.parse(e.data));
  ws.onclose = (e) => (s.closed = e.code);
  ws.onopen = () => resolve(s);
  ws.onerror = () => reject(new Error(`socket refused: ${url}`));
});
const visitorCookie = async (name, k) => /__Host-visitor=([^;]+)/.exec((await fetch(`${APP}/v/${name}?k=${k}`)).headers.get("set-cookie") ?? "")?.[1] ?? null;

test("R11 switch: owner only on the tailnet (not via Funnel, not the agent token), off by default, only in link mode, logged; leaving link turns it off", async () => {
  const name = uniq("r11s"), r = {};
  await publish(name, "tests/fixtures/poll", "v1");
  r.defaultOff = (await ownerApi(`/api/artifacts/${name}`)).body.link_write;
  r.whilePrivate = await linkWrite(name, true); // only meaningful with a link
  await ownerApi(`/api/artifacts/${name}/sharing`, { mode: "link" });
  r.agent = (await agentApi(`/api/artifacts/${name}/link-write`, { on: true })).status;
  r.ownerViaFunnel = await linkWrite(name, true, { cookie: await ownerSession(), origin: APP }); // no tailnet marker = Funnel
  r.stillOff = (await ownerApi(`/api/artifacts/${name}`)).body.link_write;
  r.owner = await linkWrite(name, true);
  r.on = (await ownerApi(`/api/artifacts/${name}`)).body.link_write;
  r.leaveLink = (await ownerApi(`/api/artifacts/${name}/sharing`, { mode: "invited" })).body.link_write;
  await ownerApi(`/api/artifacts/${name}/sharing`, { mode: "link" });
  r.newLinkStartsOff = (await ownerApi(`/api/artifacts/${name}`)).body.link_write;
  r.owner2 = await linkWrite(name, true); r.ownerOff = await linkWrite(name, false);
  r.log = (await ownerApi(`/api/events?artifact=${name}`)).body.filter((e) => e.kind === "link-write" || e.detail?.link_write)
    .map((e) => ({ kind: e.kind, viewer: e.viewer, detail: e.kind === "sharing" ? e.detail.link_write : e.detail, ts: typeof e.ts }));
  expect(r).toEqual({ defaultOff: false, whilePrivate: 409, agent: 403, ownerViaFunnel: 403, stillOff: false, owner: 200, on: true,
    leaveLink: false, newLinkStartsOff: false, owner2: 200, ownerOff: 200, log: [
      { kind: "link-write", viewer: "owner", detail: { from: false, to: true }, ts: "number" },
      { kind: "sharing", viewer: "owner", detail: { from: true, to: false }, ts: "number" },
      { kind: "link-write", viewer: "owner", detail: { from: false, to: true }, ts: "number" },
      { kind: "link-write", viewer: "owner", detail: { from: true, to: false }, ts: "number" }] });
  save("R11-switch", r);
});

test("R11 link visitors write: off = read-only (R10, no cookie); on = one id per browser (a hash of its cookie), seen live by others; still no comments or tools; off, a sharing change and a personal version take the write away", async () => {
  const name = uniq("r11w"), r = {};
  await publish(name, "tests/fixtures/poll", "v1");
  const k = new URL((await ownerApi(`/api/artifacts/${name}/sharing`, { mode: "link" })).body.url).searchParams.get("k");
  const room = `${wss(APP)}/api/rooms/${name}/app?k=${k}`, as = (c) => (c ? { cookie: `__Host-visitor=${c}` } : {});
  // switch off: R10 unchanged
  r.off = { cookie: await visitorCookie(name, k), write: (await sock(room, {}, [{ type: "vote", option: "yes" }], 3000)).closed };
  // switch on
  expect(await linkWrite(name, true)).toBe(200);
  const X = await visitorCookie(name, k), Y = await visitorCookie(name, k);
  r.cookies = { set: !!X && !!Y, distinct: X !== Y, again: await fetch(`${APP}/v/${name}?k=${k}`, { headers: as(X) }).then((x) => x.headers.get("set-cookie")) };
  const watcher = await keep(room, as(Y)), a1 = await keep(room, as(X)), a2 = await keep(room, as(X));
  a1.send({ type: "vote", option: "yes" });
  await expect.poll(() => watcher.frames.filter((f) => f.type === "vote").length).toBe(1);
  a2.send({ type: "vote", option: "no" }); // the same browser on a second socket: the same `from`
  await expect.poll(() => watcher.frames.filter((f) => f.type === "vote").length).toBe(2);
  const [v1, v2] = watcher.frames.filter((f) => f.type === "vote");
  r.from = { visitorPrefix: v1.from.startsWith("v:"), sameBrowserSameId: v1.from === v2.from, cookieNotRevealed: !v1.from.includes(X) };
  // no cookie, or one that is not ours: an id per socket; a client-sent x-room-from is dropped
  const loose = async (headers) => { const s = await sock(room, headers, [{ type: "vote", option: "yes" }], 1000); return s.closed === null ? "wrote" : s.closed; };
  for (const h of [{}, { cookie: "__Host-visitor=forged" }, { "x-room-from": "owner" }]) await loose(h);
  const all = (await sock(room, {}, [], 1000)).frames[0].messages.filter((m) => m.type === "vote").map((m) => m.from);
  r.stored = { n: all.length, distinctIds: new Set(all).size, owner: all.includes("owner"), forged: all.includes("v:forged") };
  // still view only for everything else
  r.comments = (await sock(`${wss(APP)}/api/rooms/${name}/comments?k=${k}`, as(X))).closed;
  r.tool = await fetch(`${APP}/api/tools/${name}/anything?k=${k}`, { method: "POST", headers: { "content-type": "application/json", ...as(X) }, body: "{}" }).then(async (x) => `${x.status} ${(await x.json()).error}`);
  // switch off: open visitor sockets are closed (as a new version does); their reconnect is read-only
  await linkWrite(name, false);
  await expect.poll(() => [watcher.closed, a1.closed, a2.closed]).toEqual([4012, 4012, 4012]);
  r.offAgain = (await sock(room, as(X), [{ type: "vote", option: "yes" }], 3000)).closed;
  // on again, then the owner changes sharing: the open socket is closed and the old link opens nothing
  await linkWrite(name, true);
  const b = await keep(room, as(X));
  await ownerApi(`/api/artifacts/${name}/sharing`, { mode: "invited" });
  await expect.poll(() => b.closed).toBe(4012);
  r.oldLinkAfterSharing = (await sock(room, as(X))).closed;
  // a personal version (viewer tools, DoD 6) takes no visitor writes either, switch on or not
  const k2 = new URL((await ownerApi(`/api/artifacts/${name}/sharing`, { mode: "link" })).body.url).searchParams.get("k");
  await linkWrite(name, true);
  await publish(name, "artifacts/my-items", "v2");
  expect((await ownerApi(`/api/artifacts/${name}/versions/2/approve`, {})).status).toBe(200);
  r.personal = (await sock(`${wss(APP)}/api/rooms/${name}/app?k=${k2}`, as(X), [{ type: "vote", option: "yes" }], 3000)).closed;
  expect(r).toEqual({
    off: { cookie: null, write: 4003 }, cookies: { set: true, distinct: true, again: null },
    from: { visitorPrefix: true, sameBrowserSameId: true, cookieNotRevealed: true },
    stored: { n: 5, distinctIds: 4, owner: false, forged: false },
    comments: "refused", tool: "403 view_only", offAgain: 4003, oldLinkAfterSharing: "refused", personal: 4003,
  });
  save("R11-link-visitors-write", r);
});

test("R11 poll in the browser: Andy's switch in the owner panel; visitors vote from their own browsers and see each other's votes live; the page shows buttons only while canWrite", async ({ browser }) => {
  const name = uniq("r11p"), r = {};
  await publish(name, "tests/fixtures/poll", "v1");
  const oc = await ownerContext(browser), op = await oc.newPage();
  await op.goto(`${APP}/v/${name}`);
  r.panelBeforeLink = await op.getByTestId("link-write").isDisabled();
  await openShare(op); // shell restyle: panel collapsed by default
  await op.getByTestId("sharing").selectOption("link");
  await expect(op.getByTestId("link-url")).toHaveValue(/k=/);
  const url = await op.getByTestId("link-url").inputValue();
  const visitors = [];
  for (let i = 0; i < 2; i++) { const ctx = await browser.newContext(), p = await ctx.newPage(); await p.goto(url); visitors.push({ ctx, p }); }
  for (const { p } of visitors) await expect(frame(p).getByTestId("can-write")).toHaveText("false");
  r.buttonsWhileOff = await frame(visitors[0].p).getByTestId("vote-yes").count();
  await op.getByTestId("link-write").check(); // open visitor pages pick it up without a manual reload
  for (const { p } of visitors) await expect(frame(p).getByTestId("can-write")).toHaveText("true", { timeout: 15_000 });
  await frame(visitors[0].p).getByTestId("vote-yes").press("Enter");
  await frame(visitors[1].p).getByTestId("vote-no").press("Enter");
  await frame(visitors[1].p).getByTestId("vote-yes").press("Enter"); // a changed vote: still one per browser
  for (const p of [op, ...visitors.map((v) => v.p)]) await expect(frame(p).getByTestId("tally-yes")).toHaveText("2");
  r.tallies = { yes: await frame(op).getByTestId("tally-yes").textContent(), no: await frame(op).getByTestId("tally-no").textContent() };
  await op.screenshot({ path: path.join(EVIDENCE, "R11-owner-panel-switch-on.png") });
  await visitors[1].p.setViewportSize({ width: 390, height: 500 });
  await visitors[1].p.screenshot({ path: path.join(EVIDENCE, "R11-visitor-voted.png") });
  await op.getByTestId("link-write").uncheck();
  for (const { p } of visitors) await expect(frame(p).getByTestId("can-write")).toHaveText("false", { timeout: 15_000 });
  r.buttonsAfterOff = await frame(visitors[0].p).getByTestId("vote-yes").count();
  expect(r).toEqual({ panelBeforeLink: true, buttonsWhileOff: 0, tallies: { yes: "2", no: "0" }, buttonsAfterOff: 0 });
  save("R11-poll-browser", r);
  for (const { ctx } of visitors) await ctx.close();
  await oc.close();
});
