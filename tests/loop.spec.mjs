// DoD 7, deterministic half: the real bridge
// extension (loaded by tests/support/pi-harness.mjs, no model: the test plays pi), the MCP endpoint through the official SDK
// client, and the shell in Chrome.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { APP, ROOT, AGENT_TOKEN, OWNER_NAME, TAILNET_PORT, uniq, ownerApi, ownerContext, inviteGuest, frame, note, EVIDENCE, openComments } from "./support/env.mjs";
import { startBridge, mcpClient, PI_ORIGIN } from "./support/pi-harness.mjs";

const WORK = path.join(ROOT, "test-results", "loop-work"); // gitignored; inside the repo so the bundler finds solid-js either way
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

// a raw comments-room socket from a page (the page's cookie = its identity); returns how the server answered a frame
const rawSend = (page, name, msg) => page.evaluate(async ([n, m]) => {
  const ws = new WebSocket(`wss://${location.host}/api/rooms/${n}/comments`);
  await new Promise((r) => (ws.onmessage = r)); // history first
  return await new Promise((r) => {
    ws.onclose = (e) => r({ closed: e.code, reason: e.reason });
    ws.onmessage = (e) => { ws.close(); r({ stored: JSON.parse(e.data) }); };
    ws.send(JSON.stringify(m));
  });
}, [name, msg]);
// pi's own socket (bearer token, from the tailnet): every frame the gate lets through
const agentSocket = async (name) => {
  const ws = new WebSocket(`${PI_ORIGIN.replace("https", "wss")}/api/rooms/${name}/comments`, { headers: { authorization: `Bearer ${AGENT_TOKEN}` } });
  const frames = [];
  await new Promise((r, j) => { ws.onmessage = (e) => { frames.push(JSON.parse(e.data)); r(); }; ws.onerror = () => j(new Error("agent socket refused")); });
  return { frames, close: () => ws.close() };
};

test("DoD 7: pi publishes, Andy comments, pi republishes/replies/resolves live; guest comments wait for Andy's forward; offline comments replay", async ({ browser }) => {
  const name = uniq("loop"), t = {}, stateFile = path.join(WORK, `${name}.state.json`), src = path.join(WORK, name);
  fs.mkdirSync(WORK, { recursive: true });
  fs.cpSync(path.join(ROOT, "tests/fixtures/hello"), src, { recursive: true });
  const mcp = await mcpClient();

  // ---- the endpoint is MCP (official SDK client) and only pi's ----
  expect((await mcp.listTools()).tools.map((x) => x.name)).toEqual(["publish_artifact", "list_artifacts", "get_comments", "reply_comment", "resolve_comment"]);
  // the owner's configured name (OWNER_NAME) in what pi reads from MCP
  expect((await mcp.listTools()).tools.find((x) => x.name === "get_comments").description).toContain(`${OWNER_NAME}'s own`);
  expect(mcp.getInstructions()).toMatch(new RegExp(`^${OWNER_NAME}'s artifacts platform`));
  const raw = (headers, origin = PI_ORIGIN) => fetch(origin + "/api/mcp", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' }).then((r) => r.status);
  const refusals = {
    noToken: await raw({}), wrongToken: await raw({ authorization: "Bearer nope" }),
    ownerCookie: (await ownerApi("/api/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" })).status,
    agentViaFunnel: await raw({ authorization: `Bearer ${AGENT_TOKEN}` }, APP), // APP without the tailnet marker = public traffic
  };
  expect(refusals).toStrictEqual({ noToken: 403, wrongToken: 401, ownerCookie: 403, agentViaFunnel: 403 });

  // ---- 1. pi publishes v1 (bridge tool: local Solid compile, then MCP publish_artifact); the session follows the artifact ----
  const pi = await startBridge({ stateFile });
  expect(pi.tools).toEqual(["publish_artifact", "follow_artifact"]); // follow_artifact
  const v1 = await pi.publish(name, path.relative(ROOT, src));
  expect(v1).toEqual({ name, version: 1, url: `${APP}/v/${name}` });
  expect(pi.entries).toEqual([{ type: "custom", id: "0", customType: "artifact-follow", data: { name } }]);

  // ---- 2. The owner opens it and comments in the shell ----
  const oc = await ownerContext(browser), owner = await oc.newPage();
  await owner.goto(v1.url);
  const O = frame(owner);
  await expect(O.getByTestId("heading")).toHaveText("Hello World");
  await owner.evaluate(() => (window.__noReload = true));
  await expect.poll(() => pi.statuses.at(-1)).toMatch(/following/); // the bridge's socket is up
  t.comment = Date.now();
  await openComments(owner); // shell restyle: panel collapsed by default
  await owner.getByTestId("comment-input").fill("make the heading say Hello Andy");
  await owner.getByTestId("comment-send").click();
  await expect.poll(() => pi.messages.length, { timeout: 5000 }).toBe(1);
  t.commentToPi = pi.messages[0].at - t.comment;
  const m1 = pi.messages[0];
  expect(m1.opts).toEqual({ deliverAs: "followUp" });
  expect(m1.text).toContain(`"make the heading say Hello Andy"`);
  expect(m1.text).toContain("by the owner (on v1)");
  const cid = /comment (\S+) by the owner/.exec(m1.text)[1];
  // comment states: The owner sees that pi has it until pi replies
  const th = owner.locator(`[data-testid="thread"][data-id="${cid}"]`);
  await expect(th.getByTestId("comment")).toHaveText(`${OWNER_NAME} make the heading say Hello Andy`); // who(): the configured name
  await expect(th.getByTestId("thread-working")).toBeVisible();
  await expect(th.getByTestId("thread-working")).toHaveText("pi is working…");
  await owner.screenshot({ path: `${EVIDENCE}/comment-states-working.png` });
  expect(JSON.parse(fs.readFileSync(stateFile, "utf8"))).toStrictEqual({ [PI_ORIGIN]: { [name]: 1 } }); // delivered seq saved

  // ---- 3. pi edits the source, republishes, replies, resolves (via MCP); the open viewer updates without a reload ----
  fs.writeFileSync(path.join(src, "main.jsx"), fs.readFileSync(path.join(src, "main.jsx"), "utf8").replace("Hello World", "Hello Andy"));
  t.republish = Date.now();
  expect((await pi.publish(name, path.relative(ROOT, src))).version).toBe(2);
  await expect(O.getByTestId("heading")).toHaveText("Hello Andy");
  t.republishToViewer = Date.now() - t.republish;
  expect((await mcp.tool("get_comments", { name })).map((c) => [c.id, c.text, c.from, c.version, c.resolved])).toStrictEqual([[cid, "make the heading say Hello Andy", "owner", 1, false]]);
  await mcp.tool("reply_comment", { name, comment: cid, text: "Changed the heading to Hello Andy and republished as v2." });
  await expect(th.getByTestId("thread-reply")).toHaveText("pi Changed the heading to Hello Andy and republished as v2.");
  await expect(th.getByTestId("thread-working")).toHaveCount(0); // pi's reply ends the working state (before any resolve)
  await expect(th).toBeVisible(); // replied but open: still in the main list
  await owner.screenshot({ path: `${EVIDENCE}/comment-states-replied.png` });
  await mcp.tool("resolve_comment", { name, comment: cid });
  await expect(th).toHaveAttribute("data-resolved", "true");
  // resolved threads fold away behind "Show resolved (n)" (like Claude Artifacts) and come back when toggled
  // the switch lives in the comments filter menu (comments-filter, 2026-11-25T16:38+01:00): open the menu, click it, close it
  const showResolved = owner.getByTestId("comments-show-resolved");
  const toggleResolved = async (shot, closeByOutsideClick) => {
    await owner.getByTestId("comments-filter").click();
    await expect(owner.getByTestId("comments-filter-menu")).toBeVisible();
    await showResolved.click();
    if (shot) await owner.screenshot({ path: shot });
    if (closeByOutsideClick) await owner.getByTestId("comments").getByRole("heading", { name: "Comments" }).click();
    else await owner.keyboard.press("Escape");
    await expect(owner.getByTestId("comments-filter-menu")).toBeHidden();
  };
  await expect(th).toBeHidden();
  await expect(showResolved).toHaveText("Show resolved (1)");
  await expect(showResolved).toHaveAttribute("aria-checked", "false");
  await owner.screenshot({ path: `${EVIDENCE}/comment-states-resolved-folded.png` });
  await toggleResolved(`${EVIDENCE}/comments-filter-menu-open.png`);
  await expect(th).toBeVisible();
  await expect(th.getByTestId("thread-resolved")).toBeVisible();
  await expect(showResolved).toHaveAttribute("aria-checked", "true");
  await owner.screenshot({ path: `${EVIDENCE}/comment-states-resolved-shown.png` });
  await toggleResolved(null, true);
  await expect(showResolved).toHaveAttribute("aria-checked", "false");
  await expect(th).toBeHidden();
  await expect(owner.getByTestId("artifact-version")).toHaveText("v2");
  expect(await owner.evaluate(() => window.__noReload)).toBe(true);
  await owner.screenshot({ path: `${EVIDENCE}/dod7-owner-after-resolve.png` });
  expect(pi.messages.length).toBe(1); // pi's own reply/resolve don't come back as work

  // ---- 4. a guest's comment does not reach pi (push, get_comments, pi's socket) until the owner forwards it ----
  await ownerApi(`/api/artifacts/${name}/sharing`, { mode: "invited" });
  const guest = await inviteGuest(browser, name, "Gina Guest");
  const piSocket = await agentSocket(name); // listens through the guest's comment
  await openComments(guest.page); // shell restyle: panel collapsed by default
  await guest.page.getByTestId("comment-input").fill("GUEST: make the background pink");
  await guest.page.getByTestId("comment-send").click();
  const gth = owner.locator('[data-testid="thread"]', { hasText: "GUEST: make the background pink" });
  await expect(gth).toHaveAttribute("data-for-pi", "false");
  await expect(gth.getByTestId("thread-working")).toHaveCount(0); // a guest's comment is not pi's work until the owner forwards it
  const gid = await gth.getAttribute("data-id");
  await settle(1500); // the comment reached the owner's shell; give a push to pi time to (not) arrive
  const gate = {
    pushed: pi.messages.length,
    getComments: (await mcp.tool("get_comments", { name, status: "all" })).map((c) => c.id),
    agentSocketOnConnect: piSocket.frames[0].messages.map((c) => [c.id, c.text, c.from]),
    agentSocketLeaks: piSocket.frames.filter((f) => JSON.stringify(f).includes("GUEST")).length,
    replyRefused: await mcp.tool("reply_comment", { name, comment: gid, text: "x" }).then(() => "accepted", (e) => e.message),
    resolveRefused: await mcp.tool("resolve_comment", { name, comment: gid }).then(() => "accepted", (e) => e.message),
  };
  piSocket.close();
  expect(gate).toStrictEqual({ pushed: 1, getComments: [cid], agentSocketOnConnect: [[cid, "make the heading say Hello Andy", "owner"]], agentSocketLeaks: 0,
    replyRefused: `comments: no comment ${gid} visible to pi`, resolveRefused: `comments: no comment ${gid} visible to pi` });
  // the room's rules, on raw sockets: only the owner forwards; only pi replies/resolves; nobody re-uses an id
  const rules = {
    guestForwards: await rawSend(guest.page, name, { type: "forward", comment: gid }),
    guestReplies: await rawSend(guest.page, name, { type: "reply", comment: cid, text: "as pi" }),
    ownerResolves: await rawSend(owner, name, { type: "resolve", comment: gid }),
    guestReusesId: await rawSend(guest.page, name, { type: "comment", id: cid, text: "overwrite" }),
  };
  for (const [k, r] of Object.entries(rules)) expect(r.closed, k).toBe(4003);
  t.forward = Date.now();
  await openComments(owner); // shell restyle: panel collapsed by default
  await gth.getByTestId("comment-forward").click();
  await expect.poll(() => pi.messages.length, { timeout: 5000 }).toBe(2);
  t.forwardToPi = pi.messages[1].at - t.forward;
  expect(pi.messages[1].text).toContain(`comment ${gid} by a guest (`);
  expect(pi.messages[1].text).toContain("forwarded to you by the owner");
  expect(pi.messages[1].text).toContain(`"GUEST: make the background pink"`);
  await expect(gth).toHaveAttribute("data-for-pi", "true");
  await expect(gth.getByTestId("thread-working")).toBeVisible(); // forwarded = pi's work now (same rule as the owner's own)
  await expect(gth.getByTestId("comment-forward")).toHaveCount(0);
  expect((await mcp.tool("get_comments", { name })).map((c) => [c.id, c.forwarded])).toStrictEqual([[gid, true]]); // open ones
  await mcp.tool("resolve_comment", { name, comment: gid }); // pi handled it (no page change needed for the test)
  await expect(guest.page.locator(`[data-testid="thread"][data-id="${gid}"]`)).toHaveAttribute("data-resolved", "true"); // the guest sees it live
  await expect(guest.page.locator(`[data-testid="thread"][data-id="${gid}"]`)).toBeHidden(); // and folded away for them too
  await expect(gth.getByTestId("thread-working")).toHaveCount(0); // resolving without a reply also ends the working state
  await guest.page.screenshot({ path: `${EVIDENCE}/dod7-guest-forwarded-resolved.png` });

  // ---- 5. pi offline: a comment made meanwhile arrives when the session comes back (same session entries = resume) ----
  pi.stop();
  await openComments(owner); // shell restyle: panel collapsed by default
  await owner.getByTestId("comment-input").fill("OFFLINE: add a subtitle");
  await owner.getByTestId("comment-send").click();
  await expect(owner.locator('[data-testid="thread"]', { hasText: "OFFLINE: add a subtitle" })).toHaveCount(1);
  await settle(1000);
  expect(pi.messages.length).toBe(2); // nothing reaches a stopped session
  const resumed = await startBridge({ entries: pi.entries, stateFile });
  await expect.poll(() => resumed.messages.length, { timeout: 5000 }).toBe(1);
  expect(resumed.messages[0].text).toContain(`"OFFLINE: add a subtitle"`);
  expect(resumed.messages[0].text).not.toContain("Hello Andy"); // already delivered ones are not replayed
  expect(resumed.messages[0].text).not.toContain("GUEST");
  const offId = /comment (\S+) by the owner/.exec(resumed.messages[0].text)[1];
  await mcp.tool("resolve_comment", { name, comment: offId });
  resumed.stop();

  // ---- 6. a fresh pi session (no entries): finds the artifact with list_artifacts, republishes to the same URL, and then gets
  // the comment the owner made while no session followed it ----
  await openComments(owner); // shell restyle: panel collapsed by default
  await owner.getByTestId("comment-input").fill("NOBODY: make it blue");
  await owner.getByTestId("comment-send").click();
  await expect(owner.locator('[data-testid="thread"]', { hasText: "NOBODY: make it blue" })).toHaveCount(1);
  const fresh = await startBridge({ stateFile });
  await settle(1000);
  expect(fresh.messages.length).toBe(0); // a fresh session follows nothing yet (docs/DECISIONS-loop.md A3)
  const listed = (await mcp.tool("list_artifacts")).find((a) => a.name === name);
  expect(listed).toMatchObject({ name, version: 2, url: v1.url });
  const v3 = await fresh.publish(name, path.relative(ROOT, src));
  expect(v3).toEqual({ name, version: 3, url: v1.url });
  await expect(owner.getByTestId("artifact-version")).toHaveText("v3");
  await expect.poll(() => fresh.messages.length, { timeout: 5000 }).toBe(1);
  expect(fresh.messages[0].text).toContain(`"NOBODY: make it blue"`);
  expect(fresh.messages[0].text).not.toContain("OFFLINE");
  await mcp.tool("resolve_comment", { name, comment: /comment (\S+) by the owner/.exec(fresh.messages[0].text)[1] }); // pi handled it
  fresh.stop();

  // ---- 7. network drop: the platform stays up, only pi's connection breaks; a comment made meanwhile arrives after the
  // bridge reconnects by itself (a TCP relay in front of the tailnet door plays the network) ----
  const RELAY = TAILNET_PORT + 1, conns = new Set();
  const relay = () => new Promise((r) => { const srv = net.createServer((c) => { const up = net.connect(TAILNET_PORT, "127.0.0.1"); conns.add(c).add(up);
    c.pipe(up).pipe(c); const end = () => { c.destroy(); up.destroy(); }; c.on("error", end).on("close", end); up.on("error", end).on("close", end); }); srv.listen(RELAY, "127.0.0.1", () => r(srv)); });
  let net1 = await relay();
  // (the state file is keyed by origin, and this bridge's origin is the relay: nothing is open, so nothing is delivered)
  const roaming = await startBridge({ entries: fresh.entries, stateFile, origin: PI_ORIGIN.replace(/:\d+$/, `:${RELAY}`) });
  await expect.poll(() => roaming.statuses.at(-1)).toMatch(/following/);
  await settle(500);
  expect(roaming.messages.length).toBe(0);
  net1.close(); for (const c of conns) c.destroy(); // the network goes away
  await expect.poll(() => roaming.statuses.at(-1)).toMatch(/disconnected/);
  await openComments(owner); // shell restyle: panel collapsed by default
  await owner.getByTestId("comment-input").fill("DROPPED: make the subtitle italic");
  await owner.getByTestId("comment-send").click();
  await expect(owner.locator('[data-testid="thread"]', { hasText: "DROPPED: make the subtitle italic" })).toHaveCount(1);
  await settle(2500); // a few failed reconnect attempts
  expect(roaming.messages.map((m) => m.text)).toStrictEqual([]); // nothing reaches a bridge that is cut off
  t.networkBack = Date.now();
  net1 = await relay(); // the network is back; the bridge's retry loop reconnects and the history frame carries what it missed
  await expect.poll(() => roaming.messages.length, { timeout: 10000 }).toBe(1);
  t.networkBackToPi = roaming.messages[0].at - t.networkBack;
  expect(roaming.messages[0].text).toContain(`"DROPPED: make the subtitle italic"`);
  expect(roaming.messages[0].text).not.toContain("NOBODY");
  const dropStatuses = roaming.statuses.slice();
  roaming.stop(); net1.close(); for (const c of conns) c.destroy();

  note("dod7-loop.json", { artifact: name, ms: t, dropStatuses, refusals, gate, rules, stateFile: JSON.parse(fs.readFileSync(stateFile, "utf8")),
    messagesToPi: [...pi.messages, ...resumed.messages, ...fresh.messages, ...roaming.messages].map((m) => m.text) });
  await mcp.close(); await oc.close(); await guest.ctx.close();
});

// DECISIONS A14: a session takes a page over with
// follow_artifact, without republishing: it gets the comments nobody received (replay) and then the next ones live.
test("A14 follow: a fresh session follows a page another session published, gets the missed comment and the next one, no republish", async ({ browser }) => {
  const name = uniq("follow"), stateFile = path.join(WORK, `${name}.state.json`), src = path.join(WORK, name);
  fs.mkdirSync(WORK, { recursive: true });
  fs.cpSync(path.join(ROOT, "tests/fixtures/hello"), src, { recursive: true });
  const mcp = await mcpClient();
  const comment = async (page, text) => {
    await openComments(page);
    await page.getByTestId("comment-input").fill(text);
    await page.getByTestId("comment-send").click();
    await expect(page.locator('[data-testid="thread"]', { hasText: text })).toHaveCount(1);
  };

  // session A publishes v1 and goes away; the owner comments while no session follows the page
  const a = await startBridge({ stateFile });
  const v1 = await a.publish(name, path.relative(ROOT, src));
  a.stop();
  const oc = await ownerContext(browser), owner = await oc.newPage();
  await owner.goto(v1.url);
  await expect(frame(owner).getByTestId("heading")).toHaveText("Hello World");
  await comment(owner, "MISSED: make it green");

  // session B (no entries) gets nothing until it follows; an unknown page fails loudly
  const b = await startBridge({ stateFile });
  await settle(1000);
  expect(b.messages.length).toBe(0);
  await expect(b.follow(uniq("nope"))).rejects.toThrow(/no artifact/);
  expect(b.entries).toEqual([]);
  expect(await b.follow(name)).toBe(`following ${name}`);
  expect(b.entries).toEqual([{ type: "custom", id: "0", customType: "artifact-follow", data: { name } }]); // restored on resume
  await expect.poll(() => b.messages.length, { timeout: 5000 }).toBe(1);
  expect(b.messages[0].opts).toEqual({ deliverAs: "followUp" });
  expect(b.messages[0].text).toContain(`"MISSED: make it green"`);
  await b.follow(name); // following twice adds nothing
  expect(b.entries.length).toBe(1);

  // the owner's next comment reaches B live; the page was never republished
  await comment(owner, "NEXT: add a footer");
  await expect.poll(() => b.messages.length, { timeout: 5000 }).toBe(2);
  expect(b.messages[1].text).toContain(`"NEXT: add a footer"`);
  expect(b.messages[1].text).not.toContain("MISSED");
  expect((await mcp.tool("list_artifacts")).find((x) => x.name === name)).toMatchObject({ version: 1 });
  b.stop();

  note("a14-follow.json", { artifact: name, messagesToB: b.messages.map((m) => m.text), entries: b.entries, stateFile: JSON.parse(fs.readFileSync(stateFile, "utf8")) });
  await mcp.close(); await oc.close();
});
