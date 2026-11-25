// DoD 5 (use case A: The owner's data for a guest) and DoD 6
// (use case B: one page, each viewer's own data), plus the egress allowlist. The MCP servers are the test fixtures that global setup
// starts from the stack's MCP config (tests/fixtures/mcp-studio = W2b's Studio stand-in, tests/fixtures/mcp-oauth = W2a's OAuth
// server with users alice/bob).
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { test, expect } from "@playwright/test";
import { APP, ROOT, EVIDENCE, STACK_NAME, stackRunning, stackRestarts, MCP_SERVERS, uniq, publish, bundle, ownerApi, agentApi, ownerContext, inviteGuest, frame, note, openShare } from "./support/env.mjs";

const mcpLog = (server) => fs.readFileSync(path.join(EVIDENCE, `mcp-${server}-calls.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const events = async (name) => (await ownerApi(`/api/events?artifact=${name}`)).body;
// a tool call from a page, the way the shell makes it (same origin, cookie)
const callFrom = (page, name, tool, args = {}) => page.evaluate(([n, t, a]) => fetch(`/api/tools/${n}/${t}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(a) })
  .then(async (r) => ({ status: r.status, body: await r.json() })), [name, tool, args]);

// files in the platform's data (the container's volume, or app/.celld for a native celld) containing any of the needles
function grepData(needles) {
  const running = stackRunning();
  const [cmd, args] = running ? ["docker", ["exec", "-i", `${STACK_NAME}`, "grep", "-rlaF", "-f", "-", "/app/.celld"]] : ["grep", ["-rlaF", "-f", "-", path.join(ROOT, "app/.celld")]];
  try { return { where: running ? `docker volume of ${STACK_NAME}` : "app/.celld", files: execFileSync(cmd, args, { input: needles.join("\n") + "\n", encoding: "utf8" }).split("\n").filter(Boolean) }; }
  catch (e) { if (e.status === 1) return { where: running ? `docker volume of ${STACK_NAME}` : "app/.celld", files: [] }; throw e; } // grep: 1 = no match
}

// sign in at the test OAuth server's own login page (the shell sent the browser there) and come back to the artifact
async function connectItems(page, user, name) {
  await page.getByTestId("connect").click();
  await page.waitForURL(new RegExp(`^${MCP_SERVERS.items.url.replace(/\/mcp$/, "")}/authorize`));
  await page.locator("input[name=user]").fill(user);
  await page.locator("input[name=pw]").fill(`${user}-pw`);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(`${APP}/v/${name}`);
}

test("DoD 5, use case A: a guest sees Andy's Studio data through pinned owner queries; a new owner query waits for Andy's approval", async ({ browser }) => {
  const r = {}, name = uniq("studio");
  r.v1 = await publish(name, "artifacts/studio-status", "v1");
  expect(r.v1).toMatchObject({ version: 1, approved: false }); // first owner queries: The owner approves before guests see anything
  const oc = await ownerContext(browser), owner = await oc.newPage();
  await owner.goto(`${APP}/v/${name}`);
  await expect(owner.getByTestId("approval")).toContainText("v1 waits for your approval. Guests see nothing yet.");
  await expect(owner.getByTestId("approval")).toContainText("studio/uptime (owner {})");
  await openShare(owner); // shell restyle: panel collapsed by default (the approval lives in it)
  await owner.screenshot({ path: `${EVIDENCE}/dod5-owner-approval-v1.png` });
  await owner.getByTestId("approve").click();
  await expect(owner.getByTestId("approval")).toHaveCount(0);
  // the share warning: this page runs the owner's queries for whoever sees it
  await owner.getByTestId("sharing").selectOption("invited");
  await expect(owner.getByTestId("share-warning")).toHaveText("⚠️ This page runs queries with YOUR accounts (studio/uptime, studio/sw_vers). Your invited guests see their results; link visitors don't.");
  await owner.screenshot({ path: `${EVIDENCE}/dod5-owner-share-warning.png` });

  // the guest sees the owner's data
  const g = await inviteGuest(browser, name, "Gina"), G = frame(g.page);
  await expect(G.getByTestId("q-uptime")).toHaveAttribute("data-state", "ok");
  await expect(G.getByTestId("q-uptime")).toContainText("load average");
  await expect(G.getByTestId("q-sw_vers")).toContainText("ProductName");
  await expect(G.getByTestId("q-list_scratch")).toHaveAttribute("data-state", "not_declared");
  await expect(g.page.getByTestId("consent")).toHaveCount(0); // owner tools need no viewer consent: they don't use the viewer's accounts
  const guestId = (await g.page.evaluate(() => fetch("/api/me").then((x) => x.json()))).id;
  await g.page.screenshot({ path: `${EVIDENCE}/dod5-guest-v1.png` });
  // ... and cannot call any other tool, nor send own arguments to the owner's queries
  r.guestOther = {
    list_scratch: await callFrom(g.page, name, "list_scratch"), touch_marker: await callFrom(g.page, name, "touch_marker"),
    uptimeOwnArgs: await callFrom(g.page, name, "uptime", { q: "rm -rf" }), uptimePinned: await callFrom(g.page, name, "uptime"),
  };
  expect(r.guestOther.list_scratch).toMatchObject({ status: 403, body: { error: "not_declared" } });
  expect(r.guestOther.touch_marker).toMatchObject({ status: 403, body: { error: "not_declared" } });
  expect(r.guestOther.uptimeOwnArgs).toMatchObject({ status: 403, body: { error: "args_pinned" } });
  expect(r.guestOther.uptimePinned).toMatchObject({ status: 200, body: { ok: true } });

  // pi republishes with an extra owner query: guests keep v1 until the owner approves v2
  const b2 = await bundle("artifacts/studio-status", "v2");
  b2.manifest.tools.push({ name: "list_scratch", server: "studio", binding: "owner", access: "read", args: {} });
  r.v2 = (await agentApi(`/api/artifacts/${name}/versions`, b2)).body;
  expect(r.v2).toMatchObject({ version: 2, approved: false });
  await expect(owner.getByTestId("artifact-version")).toHaveText("v2"); // the owner sees v2 at once
  await expect(owner.getByTestId("approval")).toContainText("v2 waits for your approval. Guests see v1.");
  await expect(owner.getByTestId("approval")).toContainText("studio/list_scratch (owner {})");
  await expect(frame(owner).getByTestId("q-list_scratch")).toHaveAttribute("data-state", "ok");
  await owner.screenshot({ path: `${EVIDENCE}/dod5-owner-approval-v2.png` });
  await g.page.waitForTimeout(1500); // the version event reached the guest's shell too; it re-read /api/view and stayed on v1
  await expect(g.page.getByTestId("artifact-version")).toHaveText("v1");
  await expect(G.getByTestId("q-list_scratch")).toHaveAttribute("data-state", "not_declared");
  r.guestBeforeApproval = { view: await g.page.evaluate((n) => fetch(`/api/view/${n}`).then((x) => x.json()), name), list_scratch: await callFrom(g.page, name, "list_scratch") };
  expect(r.guestBeforeApproval.view.version).toBe(1);
  expect(r.guestBeforeApproval.list_scratch).toMatchObject({ status: 403, body: { error: "not_declared" } });
  const beforeApprove = (await events(name)).at(-1).id;
  await openShare(owner); // shell restyle: panel collapsed by default
  await owner.getByTestId("approve").click();
  // the guest switches to v2 without a reload and now sees the new query
  await expect(g.page.getByTestId("artifact-version")).toHaveText("v2");
  await expect(G.getByTestId("q-list_scratch")).toHaveAttribute("data-state", "ok");
  await g.page.screenshot({ path: `${EVIDENCE}/dod5-guest-v2-after-approval.png` });
  // the tool rule: an invited guest keeps the owner's queries when the page switches to link (link visitors get none: R10 test)
  r.toLink = (await ownerApi(`/api/artifacts/${name}/sharing`, { mode: "link" })).body.warning;
  expect(r.toLink).toContain("Your invited guests see their results; link visitors don't.");
  r.guestAfterLink = await callFrom(g.page, name, "uptime");
  expect(r.guestAfterLink).toMatchObject({ status: 200, body: { ok: true } });

  // read-only means what the server says: a declared owner query on a tool without readOnlyHint is refused, and never runs
  const ro = uniq("ro");
  const b3 = await bundle("artifacts/studio-status");
  b3.manifest.tools = [{ name: "touch_marker", server: "studio", binding: "owner", access: "read", args: {} }];
  expect((await ownerApi(`/api/artifacts/${ro}/versions`, b3)).status).toBe(200);
  r.notReadOnly = await ownerApi(`/api/tools/${ro}/touch_marker`, {});
  expect(r.notReadOnly).toMatchObject({ status: 403, body: { ok: false, error: "not_read_only" } });
  expect(mcpLog("studio").filter((e) => e.tool === "touch_marker")).toEqual([]);

  // an owner query on an OAuth server the owner has not connected: the guest is told so and gets no connect link (connecting would
  // link the guest's own account); the owner himself gets the connect prompt
  const oq = uniq("ownerq");
  const b4 = await bundle("artifacts/studio-status");
  b4.manifest.tools = [{ name: "list_my_items", server: "items", binding: "owner", access: "read", args: {} }];
  expect((await ownerApi(`/api/artifacts/${oq}/versions`, b4)).status).toBe(200);
  await ownerApi(`/api/artifacts/${oq}/versions/1/approve`, {});
  await ownerApi(`/api/artifacts/${oq}/sharing`, { mode: "invited" });
  r.ownerQueryNotConnected = { owner: await ownerApi(`/api/tools/${oq}/list_my_items`, {}) };
  expect(r.ownerQueryNotConnected.owner).toMatchObject({ status: 409, body: { error: "not_connected", server: "items" } });
  const token = (await ownerApi(`/api/artifacts/${oq}/invites`, { label: "Gina" })).body.url.split("/invite/")[1];
  expect(await g.page.evaluate((t) => fetch(`/api/invites/${t}/accept`, { method: "POST" }).then((x) => x.status), token)).toBe(200); // Gina, signed in, accepts
  r.ownerQueryNotConnected.guest = await callFrom(g.page, oq, "list_my_items");
  expect(r.ownerQueryNotConnected.guest).toMatchObject({ status: 409, body: { error: "owner_not_connected" } });

  // the call log: every call with artifact, tool, binding and whose account ran it (the owner's, for owner queries)
  const ev = await events(name);
  r.toolCalls = ev.filter((e) => e.kind === "tool-call");
  const guestCalls = r.toolCalls.filter((e) => e.viewer === guestId);
  expect(guestCalls.length).toBeGreaterThan(3);
  for (const e of guestCalls) expect(e.detail).toMatchObject({ server: "studio", binding: "owner", account: "owner via studio", ok: true });
  expect(guestCalls.filter((e) => e.detail.tool === "list_scratch" && e.id < beforeApprove)).toEqual([]); // nothing before approval
  expect(guestCalls.some((e) => e.detail.tool === "list_scratch")).toBe(true);
  r.events = ev; r.studioMcpLog = mcpLog("studio");
  note("dod5-use-case-a.json", r);
  await oc.close(); await g.ctx.close();
});

test("DoD 6, use case B: one page, each viewer's own data; consent first; decline = no data; tokens encrypted at rest; refresh", async ({ browser }) => {
  test.setTimeout(150_000);
  const r = {}, name = uniq("items");
  r.v1 = await publish(name, "artifacts/my-items");
  expect(r.v1).toMatchObject({ version: 1, approved: false }); // viewer tools: every version waits for the owner
  expect((await ownerApi(`/api/artifacts/${name}/versions/1/approve`, {})).status).toBe(200);
  expect((await ownerApi(`/api/artifacts/${name}/sharing`, { mode: "invited" })).body.warning).toBeNull(); // no owner tools, no warning
  const callsBefore = mcpLog("items").filter((e) => e.tool).length;

  // Alice: consent first, nothing reaches the MCP server before her answer
  const alice = await inviteGuest(browser, name, "Alice"), A = frame(alice.page);
  await expect(alice.page.getByTestId("consent")).toBeVisible();
  await expect(alice.page.getByTestId("consent")).toContainText("list_my_items on items");
  await expect(A.getByTestId("status")).toContainText("loading your items");
  await alice.page.waitForTimeout(1000);
  expect(mcpLog("items").filter((e) => e.tool).length).toBe(callsBefore);
  r.consentRequiredServerSide = await callFrom(alice.page, name, "list_my_items"); // the server enforces it too, not just the shell
  expect(r.consentRequiredServerSide).toMatchObject({ status: 403, body: { error: "consent_required" } });
  await alice.page.screenshot({ path: `${EVIDENCE}/dod6-alice-consent.png` });
  await alice.page.getByTestId("consent-allow").click();
  await expect(A.getByTestId("status")).toHaveAttribute("data-state", "not_connected");
  await expect(alice.page.getByTestId("connect-needed")).toContainText("Connect items");
  await alice.page.screenshot({ path: `${EVIDENCE}/dod6-alice-connect.png` });
  await connectItems(alice.page, "alice", name);
  await expect(A.getByTestId("item")).toHaveText(["alice's passport", "alice's tax return"]);
  await expect(alice.page.getByTestId("consent")).toHaveCount(0); // consent stored for this version
  await alice.page.screenshot({ path: `${EVIDENCE}/dod6-alice-items.png` });

  // Bob: same URL, his own data
  const bob = await inviteGuest(browser, name, "Bob"), B = frame(bob.page);
  await bob.page.getByTestId("consent-allow").click();
  await connectItems(bob.page, "bob", name);
  await expect(B.getByTestId("item")).toHaveText(["bob's bike"]);
  await bob.page.screenshot({ path: `${EVIDENCE}/dod6-bob-items.png` });

  // Carol declines: the page shows without live data, and nothing is called for her
  const carol = await inviteGuest(browser, name, "Carol"), C = frame(carol.page);
  await carol.page.getByTestId("consent-decline").click();
  await expect(C.getByTestId("status")).toHaveAttribute("data-state", "declined");
  await expect(C.getByTestId("item")).toHaveCount(0);
  await expect(carol.page.getByTestId("consent-declined")).toBeVisible();
  await carol.page.screenshot({ path: `${EVIDENCE}/dod6-carol-declined.png` });

  // only the subject that started an OAuth flow can finish it: Bob cannot complete Carol's
  const carolStart = await carol.page.evaluate(() => fetch("/api/connect/items/start", { method: "POST", headers: { "content-type": "application/json" }, body: '{"return":"/"}' }).then((x) => x.json()));
  const state = new URL(carolStart.authorize_url).searchParams.get("state");
  r.foreignCallback = await bob.page.evaluate((s) => fetch(`/api/connect/callback?state=${encodeURIComponent(s)}&code=stolen`, { redirect: "manual" }).then(async (x) => ({ status: x.status, body: await x.json() })), state);
  expect(r.foreignCallback).toEqual({ status: 403, body: { error: "this connection was started by someone else" } });

  // refresh: Alice's access token lives 20 s; after that her next view refreshes it without asking her anything
  const issuedBefore = await fetch(new URL("/admin/issued", MCP_SERVERS.items.url)).then((x) => x.json());
  await alice.page.waitForTimeout(21_000);
  await alice.page.reload();
  await expect(A.getByTestId("item")).toHaveText(["alice's passport", "alice's tax return"]);
  r.itemsServerLog = mcpLog("items");
  expect(r.itemsServerLog.some((e) => e.user === "alice" && e.event === "refresh")).toBe(true);

  // consent is per version: after a republish (approved by the owner) Alice is asked again, and nothing is called before she answers
  r.v2 = (await agentApi(`/api/artifacts/${name}/versions`, await bundle("artifacts/my-items"))).body;
  expect(r.v2).toMatchObject({ version: 2, approved: false });
  expect((await ownerApi(`/api/artifacts/${name}/versions/2/approve`, {})).status).toBe(200);
  await expect(alice.page.getByTestId("artifact-version")).toHaveText("v2");
  await expect(alice.page.getByTestId("consent")).toBeVisible();
  const callsAtV2 = mcpLog("items").filter((e) => e.tool).length;
  await alice.page.waitForTimeout(1000);
  expect(mcpLog("items").filter((e) => e.tool).length).toBe(callsAtV2);
  await alice.page.getByTestId("consent-allow").click();
  await expect(A.getByTestId("item")).toHaveText(["alice's passport", "alice's tax return"]);
  // the tool rule: an invited guest keeps her viewer tools when the page switches to link
  await ownerApi(`/api/artifacts/${name}/sharing`, { mode: "link" });
  await alice.page.reload();
  await expect(A.getByTestId("item")).toHaveText(["alice's passport", "alice's tax return"]);
  // personal or shared (DoD 6): while her viewer tool works, the room of this page refuses her write (server-side: a raw socket)
  r.personalRoomWrite = await alice.page.evaluate((n) => new Promise((res) => {
    const ws = new WebSocket(`wss://${location.host}/api/rooms/${n}/app`);
    ws.onopen = () => ws.send(JSON.stringify({ type: "x", text: "alice's data for everyone" }));
    ws.onclose = (e) => res(e.code);
  }), name);
  expect(r.personalRoomWrite).toBe(4003);
  // the agent may call tools (R10 `write`) but can never consent, so viewer tools stay closed to it
  r.agentViewerTool = await agentApi(`/api/tools/${name}/list_my_items`, {});
  expect(r.agentViewerTool).toMatchObject({ status: 403, body: { error: "consent_required" } });

  // the call log: each call with artifact, tool, binding and which account ran it (each viewer's own)
  const ids = {};
  for (const [k, p] of [["alice", alice.page], ["bob", bob.page], ["carol", carol.page]]) ids[k] = (await p.evaluate(() => fetch("/api/me").then((x) => x.json()))).id;
  const calls = (await events(name)).filter((e) => e.kind === "tool-call");
  r.toolCalls = calls;
  const okBy = (id) => calls.filter((e) => e.viewer === id && e.detail.ok);
  expect(okBy(ids.alice).length).toBeGreaterThanOrEqual(2);
  for (const e of okBy(ids.alice)) expect(e.detail).toEqual(expect.objectContaining({ tool: "list_my_items", server: "items", binding: "viewer", account: `${ids.alice} via items` }));
  for (const e of okBy(ids.bob)) expect(e.detail.account).toBe(`${ids.bob} via items`);
  expect(okBy(ids.bob).length).toBeGreaterThanOrEqual(1);
  expect(calls.filter((e) => e.viewer === ids.carol)).toEqual([]);
  // the MCP server saw exactly alice's and bob's own identities
  expect(new Set(r.itemsServerLog.filter((e) => e.tool).map((e) => e.user))).toEqual(new Set(["alice", "bob"]));

  // tokens at rest: none of the issued tokens is readable in the platform's data; control: a plaintext value stored there is found
  r.issued = await fetch(new URL("/admin/issued", MCP_SERVERS.items.url)).then((x) => x.json());
  expect(r.issued.length).toBeGreaterThan(issuedBefore.length); // the refresh issued new ones
  r.grepTokens = grepData(r.issued);
  r.grepControl = grepData([name]);
  expect(r.grepControl.files.length, "the grep must see plaintext in this storage (control)").toBeGreaterThan(0);
  expect(r.grepTokens.files, "a known test token is readable in the data").toEqual([]);
  r.ids = ids;
  note("dod6-use-case-b.json", { ...r, issued: r.issued.map((t) => t.replace(/-[0-9a-f-]{36}$/, "-<uuid>")) });
  for (const x of [alice, bob, carol]) await x.ctx.close();
});

// DoD 6 "personal or shared" (the owner). Writes are decided per socket at connect (the Worker's
// x-room-from), so a version change must close open sockets; approve and rollback send the same version event as publish.
test("DoD 6, personal or shared: a version that declares viewer tools takes no room writes, also on a socket opened before it", async ({ browser }) => {
  const name = uniq("personal");
  expect(await publish(name, "artifacts/shared-list", "v1")).toMatchObject({ version: 1, approved: true }); // shared: no tools
  const oc = await ownerContext(browser), owner = await oc.newPage();
  await owner.goto(APP + "/");
  const open = (n) => owner.evaluate((n) => new Promise((res) => {
    const ws = new WebSocket(`wss://${location.host}/api/rooms/${n}/app`), s = { ws, closed: null, frames: [] };
    ws.onclose = (e) => (s.closed = e.code);
    ws.onmessage = (e) => s.frames.push(JSON.parse(e.data));
    ws.onopen = () => { (window.__socks ??= []).push(s); res(window.__socks.length - 1); };
  }), n);
  const send = (i, text) => owner.evaluate(([i, text]) => { window.__socks[i].ws.send(JSON.stringify({ type: "x", text })); }, [i, text]);
  const closed = (i) => owner.evaluate((i) => window.__socks[i].closed, i);
  const old = await open(name);
  await send(old, "shared v1");
  await expect.poll(() => owner.evaluate((i) => window.__socks[i].frames.some((f) => f.type === "x"), old)).toBe(true); // stored (its echo)
  // pi publishes v2 with a viewer tool (the owner sees it at once): the open socket is closed and a new one cannot write
  expect((await agentApi(`/api/artifacts/${name}/versions`, await bundle("artifacts/my-items"))).body).toMatchObject({ version: 2, approved: false });
  await expect.poll(() => closed(old)).toBe(4012);
  const fresh = await open(name);
  await send(fresh, "on a new socket on v2");
  await expect.poll(() => closed(fresh)).toBe(4003);
  // the new socket got the history on connect (only the shared write) and no echo of its own refused write
  const frames = await owner.evaluate((i) => window.__socks[i].frames, fresh);
  expect(frames.map((f) => f.type)).toEqual(["history"]);
  expect(frames[0].messages.filter((m) => m.type === "x").map((m) => m.text)).toEqual(["shared v1"]);
  await oc.close();
});

test("egress: the platform contacts only the origins of Andy's MCP config, even when a server's OAuth metadata points elsewhere", async () => {
  // a configured server ("rogue") whose metadata names an authorization server on another origin (same host, port + 1)
  const rogueUrl = new URL(MCP_SERVERS.rogue.url), off = `http://${rogueUrl.hostname}:${Number(rogueUrl.port) + 1}`;
  const hits = { rogue: [], offList: [] };
  let mode = "metadata"; // "metadata": the metadata names the off-list origin; "redirect": every request is redirected there
  const rogue = http.createServer((q, s) => {
    hits.rogue.push(`${mode} ${q.method} ${q.url}`);
    if (mode === "redirect") return s.writeHead(307, { location: `${off}${q.url}` }).end();
    if (q.url.startsWith("/.well-known/oauth-protected-resource")) return s.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ resource: rogueUrl.href, authorization_servers: [off] }));
    s.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${rogueUrl.origin}/.well-known/oauth-protected-resource/mcp"` }).end();
  });
  const offList = http.createServer((q, s) => { hits.offList.push(q.url); s.writeHead(404).end(); });
  await new Promise((ok) => rogue.listen(Number(rogueUrl.port), "127.0.0.1", ok));
  await new Promise((ok) => offList.listen(Number(rogueUrl.port) + 1, "127.0.0.1", ok));
  try {
    const before = (await ownerApi("/api/events")).body[0]?.id ?? 0;
    const res = await ownerApi("/api/connect/rogue/start", { return: "/" });
    expect(res).toEqual({ status: 502, body: { error: `egress to ${off} is not allowed for MCP server "rogue"` } });
    expect(hits.rogue.length, "control: the configured origin itself was reachable").toBeGreaterThan(0);
    expect(hits.offList).toEqual([]);
    const denied = (await ownerApi("/api/events")).body.filter((e) => e.id > before && e.kind === "egress-denied");
    expect(denied.map((e) => e.detail)).toContainEqual({ server: "rogue", origin: off });
    // redirects are never followed to another origin (the fetch is redirect: "manual"; nothing reaches the off-list origin)
    mode = "redirect";
    const redirected = await ownerApi("/api/connect/rogue/start", { return: "/" });
    expect(redirected).toMatchObject({ status: 502, body: { error: expect.stringMatching(new RegExp(`^MCP server "rogue": .*Redirect to ${off.replace(/[.]/g, "\\.")}/.* not followed`)) } });
    expect(hits.rogue.filter((h) => h.startsWith("redirect")).length, "control: the configured origin answered with redirects").toBeGreaterThan(0);
    expect(hits.offList).toEqual([]);
    note("egress-allowlist.json", { response: res, redirected, hits, deniedEvents: denied });
  } finally { rogue.close(); offList.close(); }
});

// P2 (pre-Funnel review): review/big-mcp-response.mjs as a test. A configured server
// answered with 500 MB of JSON while the owner connected, and Docker killed the container (OOM). Passes when the platform cuts
// the answer at its cap and says so (502 naming the cap), stays up, and a Docker stack's container did not restart. celld still
// reads the rest off the connection and drops it (src/worker/tools.ts).
test("P2 response cap: a configured server's 500 MB answer is cut at 16 MiB (502), and the platform stays up", async () => {
  test.setTimeout(120_000);
  const rogueUrl = new URL(MCP_SERVERS.rogue.url), MB = 500, chunk = "A".repeat(1 << 20);
  const rogue = http.createServer((q, s) => {
    let i = 0, closed = false; s.on("close", () => (closed = true));
    s.writeHead(200, { "content-type": "application/json" }); s.write('{"resource":"');
    const pump = () => { while (i < MB && !closed) { i++; if (!s.write(chunk)) return s.once("drain", pump); } if (!closed) s.end('"}'); };
    pump();
  });
  await new Promise((ok) => rogue.listen(Number(rogueUrl.port), "127.0.0.1", ok));
  try {
    const r = { before: stackRestarts() };
    r.connect = await ownerApi("/api/connect/rogue/start", { return: "/" });
    r.me = (await fetch(`${APP}/api/me`)).status;
    r.after = stackRestarts();
    note("P2-response-cap.json", r);
    expect(r).toMatchObject({ before: r.before, connect: { status: 502, body: { error: expect.stringContaining(`is over ${16 * 1024 * 1024} bytes`) } }, me: 200, after: r.before });
  } finally { rogue.closeAllConnections(); rogue.close(); }
});

// M1 (pre-Funnel review): review/hang-mcp.mjs as a test. A configured server accepted the
// connection and never answered; the owner's connect hung (60 s+) and queued every later request for (owner, rogue) behind it.
// Passes when gatewayFetch's 20 s deadline ends it as an upstream failure (502 in the OAuth step). Tool calls go through the same
// fetch and catch (upstream_error), but that path is not tested here: rogue is an OAuth server without tokens (not_connected first).
test("M1 request timeout: a configured server that never answers fails after 20 s per request (502), not never", async () => {
  test.setTimeout(90_000);
  const rogueUrl = new URL(MCP_SERVERS.rogue.url), hits = [];
  const rogue = http.createServer((q) => hits.push(`${q.method} ${q.url}`)); // reads the request, never answers
  await new Promise((ok) => rogue.listen(Number(rogueUrl.port), "127.0.0.1", ok));
  try {
    const t0 = Date.now(), connect = await ownerApi("/api/connect/rogue/start", { return: "/" }), r = { connect, ms: Date.now() - t0, hits };
    note("M1-request-timeout.json", r);
    expect(hits.length, "control: the request reached the hanging server").toBeGreaterThan(0);
    expect(r.connect).toEqual({ status: 502, body: { error: 'MCP server "rogue": The operation was aborted due to timeout' } });
    // the deadline is per request: the SDK takes a failed protected-resource lookup as "none" and asks the authorization-server
    // metadata next, so a connect to a hung server takes 2 x 20 s (seen: 40,020 ms for these two hits)
    expect(r.ms).toBeGreaterThanOrEqual(hits.length * 19_000);
    expect(r.ms).toBeLessThan(hits.length * 20_000 + 10_000);
  } finally { rogue.closeAllConnections(); rogue.close(); }
});
