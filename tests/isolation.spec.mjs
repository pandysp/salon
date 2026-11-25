// DoD 3: isolation.
// The adversarial artifact (tests/fixtures/evil) runs as an invited guest and tries everything it must not be able to do;
// the owner watches the same rooms. W3c's C1 attack (a stashed per-request viewer capability in artifact server code) has
// nothing to run against in v1: there is no artifact server code. Its C3 half (artifact JS calling platform endpoints as the
// viewer) is tested here.
import https from "node:https";
import { tls } from "./support/tls.mjs";
import { test, expect } from "@playwright/test";
import { APP, CONTENT, CANARY_PORT, uniq, bundle, ownerApi, ownerContext, inviteGuest, frame, note, EVIDENCE, openComments } from "./support/env.mjs";

test("DoD 3: the adversarial artifact cannot escape; nothing reaches the canary; its frame cannot navigate to other origins", async ({ browser }) => {
  const leaks = []; // the canary host: fetch, image and navigation attempts of the artifact all aim here
  const leakServer = https.createServer(tls(), (q, r) => { leaks.push(q.url); r.end("leak received"); }); // https: no mixed-content blocking to hide behind
  // the canary port: CANARY_PORT in tests/support/env.mjs (proxy +4, layout in scripts/local-env.sh), the one source; the fixture
  // carries a placeholder filled in at publish, so parallel stacks don't collide
  await new Promise((r) => leakServer.listen(CANARY_PORT, "127.0.0.1", r));
  try {
    const name = uniq("evil");
    // (chunk 3: the fixture's owner query makes v1 wait for the owner's approval before a guest sees it. Its viewer
    // tool and the consent clicks are gone: DoD 6 would make the room read-only, and check 6 needs it)
    const evil = await bundle("tests/fixtures/evil");
    evil.files["evil.js"] = evil.files["evil.js"].replace("__CANARY_PORT__", String(CANARY_PORT));
    expect((await ownerApi(`/api/artifacts/${name}/versions`, evil)).body).toMatchObject({ version: 1, approved: false });
    expect((await ownerApi(`/api/artifacts/${name}/versions/1/approve`, {})).status).toBe(200);
    await ownerApi(`/api/artifacts/${name}/sharing`, { mode: "invited" });
    const oc = await ownerContext(browser), owner = await oc.newPage();
    await owner.goto(`${APP}/v/${name}`);
    const g = await inviteGuest(browser, name, "Mallory");
    const guestUrl = g.page.url();
    const G = frame(g.page), O = frame(owner);
    await expect(G.getByTestId("results")).not.toHaveText("running", { timeout: 20_000 });
    const r = JSON.parse(await G.getByTestId("results").textContent());
    const guestId = r.viewer.id;
    expect(r.viewer.kind).toBe("guest");

    // 1. cookies: the artifact's document has none. The hosts are the same site (as in production), so cookies the artifact
    // sets for the shared parent domain DO reach the app host, but none of them can be the __Host- session cookie, and the
    // app ignores the rest.
    expect(r.cookie).toBe("");
    expect(r.sharedParentDomain).toBe(new URL(APP).hostname.split(".").slice(1).join("."));
    const appCookies = await g.ctx.cookies(APP);
    const sessions = appCookies.filter((c) => c.name === "__Host-session");
    expect(sessions.length).toBe(1);
    expect(sessions[0].value).not.toMatch(/^evil/);
    expect(appCookies.map((c) => c.name).sort()).toEqual(["__Host-session", "__Secure-session", "session"]); // the parent-domain ones arrived
    expect((await g.page.evaluate(() => fetch("/api/me").then((x) => x.json()))).id).toBe(guestId);
    // 2. no network (CSP connect-src 'none', img-src 'self'): nothing reaches the canary
    for (const k of ["fetchSelf", "fetchAppMe", "fetchAppPost", "fetchCanary", "websocketComments"]) expect(r[k], k).toMatch(/^blocked/);
    expect(r.image).toBe("blocked: error");
    // 3. no popups, no top navigation, no access to the shell's DOM
    expect(r.popup).toBe("null");
    expect(r.parentDom).toMatch(/^blocked: SecurityError/);
    await G.getByTestId("topnav").press("Enter");
    await expect(G.getByTestId("topnav-result")).toHaveText(/^blocked: SecurityError/);
    await g.page.waitForTimeout(300);
    expect(g.page.url()).toBe(guestUrl);
    // 4. tools: only manifest tools pass (the declared owner query reaches the server, below); a path trick in the name does not help
    expect(r.toolUndeclared).toMatchObject({ ok: false, error: "not_declared" });
    expect(r.toolRaw).toMatchObject({ ok: false, error: "not_declared" });
    expect(r.ownerToolOwnArgs).toMatchObject({ ok: false, error: "args_pinned" });
    expect(r.ownerToolPinned).toMatchObject({ ok: false, error: "unknown_tool" }); // the pinned call passes every check and reaches the Studio server, which has no such tool
    // 6. impersonation: the room stamped the guest's id although the artifact claimed "owner"
    await expect(O.getByTestId("roomlog")).toContainText(`impersonation by ${guestId}`);
    const ownerSees = JSON.parse(await O.getByTestId("roomlog").textContent()).find((m) => m.text === `impersonation by ${guestId}`);
    expect(ownerSees.from).toBe(guestId); // the artifact claimed "owner"
    expect(ownerSees.seq).not.toBe(999999);
    // 5. comments room: no message from the artifact arrived (read with a raw owner socket after the attempts)
    await owner.waitForTimeout(500);
    const comments = await owner.evaluate(async (n) => {
      const ws = new WebSocket(`wss://${location.host}/api/rooms/${n}/comments`);
      const h = await new Promise((res) => (ws.onmessage = (e) => res(JSON.parse(e.data))));
      ws.close();
      return h.messages;
    }, name);
    expect(comments).toEqual([]);
    await expect(owner.getByTestId("comment")).toHaveCount(0);
    // the guest's shell still writes comments normally (control: the room works, the artifact just cannot reach it)
    await openComments(g.page); // shell restyle: panel collapsed by default
    await g.page.getByTestId("comment-input").fill("a real comment from the shell");
    await g.page.getByTestId("comment-send").click();
    await expect(owner.getByTestId("comment")).toHaveText([`${guestId} a real comment from the shell`]);

    // the content host's headers
    const asFrame = { headers: { "sec-fetch-dest": "iframe" } }; // as the shell's frame loads it (review F8: otherwise a 403)
    const res = await fetch(await g.page.locator('[data-testid="artifact-frame"]').getAttribute("src"), asFrame);
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain(`frame-ancestors ${APP}`);
    // Referrer-Policy: no-referrer on both hosts (content file, SDK, shell page, API)
    const rp = {};
    for (const u of [await g.page.locator('[data-testid="artifact-frame"]').getAttribute("src"), `${CONTENT}/_sdk/artifact-sdk.js`, `${CONTENT}/nope`, `${APP}/v/${name}`, `${APP}/api/me`, `${APP}/api/nope`])
      rp[u.replace(/\/c\/[^/]+/, "/c/<cap>")] = (await fetch(u, asFrame)).headers.get("referrer-policy");
    expect(Object.values(rp).every((v) => v === "no-referrer"), JSON.stringify(rp)).toBe(true);
    // defence in depth for C3: even if CSP were bypassed, a write from the content origin with the viewer's cookie is refused
    const sid = (await g.ctx.cookies(APP)).find((c) => c.name === "__Host-session").value;
    const c3 = await fetch(`${APP}/api/tools/${name}/owner_query`, { method: "POST", headers: { origin: CONTENT, cookie: `__Host-session=${sid}`, "content-type": "application/json" }, body: "{}" });
    expect(c3.status).toBe(403);
    await g.page.screenshot({ path: `${EVIDENCE}/dod3-guest-before-nav.png` });

    // the frame navigates itself to an outside URL with data in it. The shell's own CSP (frame-src <content origin>) governs
    // navigations of its child frame, so the request is blocked before it leaves the browser: the frame ends on Chrome's
    // error page and the canary sees nothing. Negative control (frame-src widened to *): the data arrives.
    const navs = [];
    g.page.on("framenavigated", (f) => { if (f !== g.page.mainFrame()) navs.push(f.url()); });
    await G.getByTestId("nav").press("Enter");
    // wait for either outcome (blocked frame or a canary hit), then require "blocked"
    await expect.poll(() => navs.some((u) => u.startsWith("chrome-error://")) || leaks.length > 0).toBe(true);
    await g.page.waitForTimeout(500);
    expect(leaks).toEqual([]);
    const events = (await ownerApi(`/api/events?artifact=${name}`)).body;
    const denied = events.filter((e) => e.kind === "tool-denied" && e.viewer === guestId).map((e) => e.detail.tool);
    expect(denied).toEqual(["undeclared_tool", "owner_query", "../tools/other/declared_tool"]);
    await g.page.screenshot({ path: `${EVIDENCE}/dod3-guest-nav-blocked.png` });

    // the frame navigates itself to an app-host URL: frame-src (content host only) blocks that too. On the way, the browser
    // itself confirms the two hosts are the same site (Sec-Fetch-Site of the frame request).
    const frameReq = g.page.waitForRequest((q) => q.url().startsWith(CONTENT + "/c/"));
    await g.page.reload();
    const frameSecFetchSite = (await (await frameReq).allHeaders())["sec-fetch-site"];
    expect(frameSecFetchSite).toBe("same-site");
    await expect(G.getByTestId("results")).not.toHaveText("running", { timeout: 20_000 });
    await G.getByTestId("navapp").press("Enter");
    await expect.poll(() => navs.filter((u) => u.startsWith("chrome-error://")).length === 2 || navs.some((u) => u.startsWith(APP))).toBe(true);
    expect(navs.filter((u) => u.startsWith(APP))).toEqual([]);
    expect(leaks).toEqual([]); // and the canary still saw nothing (second run of all attacks after the reload)
    note("dod3-isolation.json", { artifact: name, referrerPolicy: rp, results: r, appCookies: appCookies.map(({ name, domain, value }) => ({ name, domain, value: name === "__Host-session" ? "<real session>" : value })), frameSecFetchSite, ownerSeesImpersonation: ownerSees, comments, csp, c3Status: c3.status, canaryRequests: leaks, appHostNavFrames: navs, events });
    await oc.close(); await g.ctx.close();
  } finally {
    leakServer.close();
  }
});
