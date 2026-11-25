// DoD 4: the bake-off shared list, ported to the SDK, as a room artifact.
import { test, expect, webkit } from "@playwright/test";
import { APP, uniq, publish, ownerApi, ownerContext, inviteGuest, frame, note, EVIDENCE } from "./support/env.mjs";

test("DoD 4: owner (WebKit) + guest (Chrome) share the list live (<= 1 s), reload keeps it, republish keeps it and swaps the version live", async ({ browser }) => {
  const name = uniq("list");
  await publish(name, "artifacts/shared-list", "list v1");
  await ownerApi(`/api/artifacts/${name}/sharing`, { mode: "invited" });
  const wk = await webkit.launch({ channel: undefined, args: [] }); // the owner on the iPhone: WebKit (the guest stays in Chrome: passkeys use Chrome's virtual authenticator)
  const oc = await ownerContext(wk), owner = await oc.newPage();
  await owner.goto(`${APP}/v/${name}`);
  const guest = await inviteGuest(browser, name, "Gina Guest");
  const O = frame(owner), G = frame(guest.page);
  await expect(O.getByTestId("app-version")).toHaveText("list v1");
  await expect(G.getByTestId("app-viewer")).toHaveText("Gina Guest");
  await expect(O.getByTestId("status")).toHaveText("connected");
  await expect(G.getByTestId("status")).toHaveText("connected");

  const timings = {};
  const live = async (label, act, check) => { const t0 = Date.now(); await act(); await check(); timings[label] = Date.now() - t0; };
  // check with a 1 s budget: the DoD limit, not a generous default
  await live("guest add -> owner sees", async () => { await G.getByTestId("new-item-input").fill("milk"); await G.getByTestId("new-item-input").press("Enter"); },
    () => expect(O.getByTestId("item-title")).toHaveText(["milk"], { timeout: 1000 }));
  await live("owner add -> guest sees", async () => { await O.getByTestId("new-item-input").fill("eggs"); await O.getByTestId("new-item-input").press("Enter"); },
    () => expect(G.getByTestId("item-title")).toHaveText(["milk", "eggs"], { timeout: 1000 }));
  await live("owner toggle -> guest sees", () => O.getByTestId("item-toggle").first().press("Space"),
    () => expect(G.getByTestId("item-toggle").first()).toBeChecked({ timeout: 1000 }));
  await live("guest delete -> owner sees", () => G.getByTestId("item-delete").nth(1).press("Enter"),
    () => expect(O.getByTestId("item-title")).toHaveText(["milk"], { timeout: 1000 }));
  // one step by mouse (the frame has been up for a while: see the routing note in tests/support/env.mjs)
  await G.getByTestId("new-item-input").fill("bread"); await G.getByTestId("add-item").click();
  await expect(O.getByTestId("item-title")).toHaveText(["milk", "bread"], { timeout: 1000 });

  // reload keeps state
  await guest.page.reload();
  await expect(G.getByTestId("item-title")).toHaveText(["milk", "bread"]);
  await expect(G.getByTestId("item-toggle").first()).toBeChecked();

  // republish: list kept, open viewers switch to v2 without a page reload
  for (const p of [owner, guest.page]) await p.evaluate(() => (window.__noReload = true));
  const v2 = await publish(name, "artifacts/shared-list", "list v2");
  await expect(O.getByTestId("app-version")).toHaveText("list v2");
  await expect(G.getByTestId("app-version")).toHaveText("list v2");
  await expect(owner.getByTestId("artifact-version")).toHaveText(`v${v2.version}`);
  for (const p of [owner, guest.page]) expect(await p.evaluate(() => window.__noReload)).toBe(true);
  await expect(G.getByTestId("item-title")).toHaveText(["milk", "bread"]);
  await expect(O.getByTestId("item-title")).toHaveText(["milk", "bread"]);
  await G.getByTestId("new-item-input").fill("after v2"); await G.getByTestId("new-item-input").press("Enter");
  await expect(O.getByTestId("item-title")).toHaveText(["milk", "bread", "after v2"], { timeout: 1000 });

  await owner.screenshot({ path: `${EVIDENCE}/dod4-owner.png` });
  await guest.page.screenshot({ path: `${EVIDENCE}/dod4-guest.png` });
  note("dod4-timings.json", { artifact: name, owner_browser: `webkit ${wk.version()}`, guest_browser: `chrome ${browser.version()}`, ms: timings, limit_ms: 1000 });
  await oc.close(); await wk.close(); await guest.ctx.close();
});

test("rooms: from is server-stamped; $-types are reserved (never stored, never reach other sockets)", async ({ browser }) => {
  const name = uniq("reserved");
  await publish(name, "artifacts/shared-list", "r1");
  const oc = await ownerContext(browser), owner = await oc.newPage();
  await owner.goto(APP + "/");
  // raw clients of the app room (what the shell forwards for the artifact): same-origin sockets as the owner
  const result = await owner.evaluate(async (n) => {
    const open = async () => {
      const ws = new WebSocket(`wss://${location.host}/api/rooms/${n}/app`), frames = [];
      ws.onmessage = (e) => frames.push(JSON.parse(e.data));
      await new Promise((r) => (ws.onopen = r));
      return { ws, frames };
    };
    const sender = await open(), observer = await open();
    sender.ws.send(JSON.stringify({ type: "note", text: "x", from: "somebody-else", seq: 999999, ts: 1 }));
    await new Promise((r) => setTimeout(r, 500));
    const closed = Promise.race([new Promise((r) => (sender.ws.onclose = (e) => r({ code: e.code, reason: e.reason }))), new Promise((r) => setTimeout(() => r({ code: null }), 2000))]);
    sender.ws.send(JSON.stringify({ type: "$platform", event: "version", version: 999 }));
    const close = await closed;
    await new Promise((r) => setTimeout(r, 500));
    const late = await open(); // a new viewer gets the stored history
    await new Promise((r) => setTimeout(r, 300));
    return { senderFrames: sender.frames, observerFrames: observer.frames, close, lateHistory: late.frames[0] };
  }, name);
  const note1 = result.observerFrames.find((f) => f.type === "note");
  expect(note1.from).toBe("owner");     // client claimed "somebody-else"
  expect(note1.seq).toBe(1);            // client claimed 999999
  expect(note1.ts).toBeGreaterThan(1);  // client claimed 1
  expect(result.observerFrames.some((f) => f.type === "$platform")).toBe(false);
  expect(result.lateHistory.type).toBe("history");
  expect(result.lateHistory.messages.map((m) => m.type)).toEqual(["note"]);
  expect(result.close.code).toBe(4003);
  note("rooms-reserved.json", result);
  await oc.close();
});

test("rooms cap the message rate per socket (close 4008); nothing past the cap is stored", async ({ browser }) => {
  const name = uniq("rate");
  await publish(name, "artifacts/shared-list", "r1");
  const oc = await ownerContext(browser), owner = await oc.newPage();
  await owner.goto(APP + "/");
  const result = await owner.evaluate(async (n) => {
    const open = () => new Promise((r) => { const ws = new WebSocket(`wss://${location.host}/api/rooms/${n}/app`); const f = []; ws.onmessage = (e) => f.push(JSON.parse(e.data)); ws.onopen = () => r({ ws, f }); });
    const a = await open();
    const closed = Promise.race([new Promise((r) => (a.ws.onclose = (e) => r({ code: e.code, reason: e.reason }))), new Promise((r) => setTimeout(() => r({ code: null }), 3000))]);
    for (let i = 1; i <= 120; i++) a.ws.send(JSON.stringify({ type: "spam", i }));
    const close = await closed;
    await new Promise((r) => setTimeout(r, 300));
    const b = await open();
    await new Promise((r) => setTimeout(r, 300));
    b.ws.close();
    return { close, stored: b.f[0].messages.filter((m) => m.type === "spam").length };
  }, name);
  expect(result).toEqual({ close: { code: 4008, reason: "rate limit" }, stored: 100 });
  note("rooms-rate-cap.json", result);
  await oc.close();
});

test("rooms cap the message size (64 KB, close 4003); the oversized message is not stored", async ({ browser }) => {
  const name = uniq("size");
  await publish(name, "artifacts/shared-list", "z1");
  const oc = await ownerContext(browser), owner = await oc.newPage();
  await owner.goto(APP + "/");
  const result = await owner.evaluate(async (n) => {
    const open = () => new Promise((r) => { const ws = new WebSocket(`wss://${location.host}/api/rooms/${n}/app`); const f = []; ws.onmessage = (e) => f.push(JSON.parse(e.data)); ws.onopen = () => r({ ws, f }); });
    const a = await open();
    const closed = Promise.race([new Promise((r) => (a.ws.onclose = (e) => r({ code: e.code, reason: e.reason }))), new Promise((r) => setTimeout(() => r({ code: null }), 3000))]);
    a.ws.send(JSON.stringify({ type: "small", text: "x".repeat(60 * 1024) }));
    a.ws.send(JSON.stringify({ type: "big", text: "x".repeat(70 * 1024) }));
    const close = await closed;
    const b = await open();
    await new Promise((r) => setTimeout(r, 300));
    b.ws.close();
    return { close, stored: b.f[0].messages.map((m) => m.type) };
  }, name);
  expect(result).toEqual({ close: { code: 4003, reason: "invalid message: message too large" }, stored: ["small"] });
  note("rooms-size-cap.json", result);
  await oc.close();
});
