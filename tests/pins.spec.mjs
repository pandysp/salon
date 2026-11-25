// Comment pins: the owner switches comment mode on, clicks an
// element inside the sandboxed frame, and the pinned composer's comment (with the element's text as a quote) lands in the comments
// room; a link visitor (no comment right) gets no comment mode.
import { test, expect } from "@playwright/test";
import path from "node:path";
import { APP, ROOT, uniq, publish, ownerApi, ownerContext, frame, EVIDENCE } from "./support/env.mjs";
import { startBridge, mcpClient } from "./support/pi-harness.mjs";

// the comments room's history as the server stores it, read over a raw socket with this page's cookie
const roomHistory = (page, name) => page.evaluate(async (n) => {
  const ws = new WebSocket(`wss://${location.host}/api/rooms/${n}/comments`);
  const m = await new Promise((r) => (ws.onmessage = (e) => r(JSON.parse(e.data))));
  ws.close();
  return m.messages;
}, name);

test("comment pins: owner picks an element in the frame, the quoted comment lands in the room; a link visitor has no comment mode", async ({ browser }) => {
  const name = uniq("pins");
  await publish(name, "tests/fixtures/hello", "pins v1");
  const url = (await ownerApi(`/api/artifacts/${name}/sharing`, { mode: "link" })).body.url;

  const oc = await ownerContext(browser), owner = await oc.newPage();
  await owner.goto(`${APP}/v/${name}`);
  const O = frame(owner);
  await expect(O.getByTestId("heading")).toHaveText("Hello World");
  await expect(owner.getByTestId("comment-pin")).toHaveCount(0);

  // comment mode on: the SDK in the frame frames what the mouse is over; a click picks it instead of acting
  await owner.getByTestId("comment-mode").click();
  await expect(owner.getByTestId("comment-mode")).toHaveAttribute("aria-pressed", "true");
  await O.getByTestId("heading").hover();
  // the SDK's hover frame sits on the heading (2 px outside it)
  const hb = await O.getByTestId("heading").boundingBox();
  await expect.poll(async () => { const f = await O.locator("html > div[aria-hidden]").boundingBox(); return f && [f.x - hb.x, f.y - hb.y, f.width - hb.width, f.height - hb.height].map(Math.round); }).toEqual([-2, -2, 4, 4]);
  await owner.screenshot({ path: `${EVIDENCE}/comment-pins-hover.png` });
  await O.getByTestId("heading").click();
  const pin = owner.getByTestId("comment-pin");
  await expect(pin).toBeVisible();
  await expect(pin.getByTestId("comment-pin-quote")).toHaveText("Hello World");
  await expect(pin.getByTestId("comment-pin-agent")).toBeChecked(); // default on: The owner's comments reach pi unless he unticks it (test below)
  // pinned at the element: just below the heading, inside the frame's area
  const [h, p] = [await O.getByTestId("heading").boundingBox(), await pin.boundingBox()];
  expect(Math.abs(p.y - (h.y + h.height + 6))).toBeLessThan(4);
  expect(Math.abs(p.x - h.x)).toBeLessThan(4);
  await pin.getByTestId("comment-pin-input").fill("make the heading bigger");
  await owner.screenshot({ path: `${EVIDENCE}/comment-pins-composer.png` });
  await pin.getByTestId("comment-pin-send").click();

  // it lands in the existing comments room, quote first, in today's comment shape
  await expect(owner.getByTestId("comment-pin")).toHaveCount(0);
  await expect(owner.getByTestId("comment-mode")).toHaveAttribute("aria-pressed", "false");
  await expect(owner.getByTestId("comment").last()).toContainText("> Hello World\n\nmake the heading bigger");
  await expect(owner.locator('[data-testid="thread"]').last()).toHaveAttribute("data-for-pi", "true");
  await owner.waitForTimeout(300); // the panel's slide-in, for the screenshot
  await owner.screenshot({ path: `${EVIDENCE}/comment-pins-sent.png` });
  const stored = (await roomHistory(owner, name)).filter((m) => m.type === "comment");
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({ type: "comment", from: "owner", text: "> Hello World\n\nmake the heading bigger", version: 1 });
  expect(Object.keys(stored[0]).sort()).toEqual(["from", "id", "seq", "text", "ts", "type", "version"]);

  // comment mode is off again: the page's own clicks act normally (no frame, no pick)
  await O.getByTestId("heading").click();
  await expect(owner.getByTestId("comment-pin")).toHaveCount(0);

  // a link visitor has no comment right: no comment mode, no comments
  const vc = await browser.newContext(), visitor = await vc.newPage();
  await visitor.goto(url);
  await expect(frame(visitor).getByTestId("heading")).toHaveText("Hello World");
  await expect(visitor.getByTestId("comment-mode")).toHaveCount(0);
  await expect(visitor.getByTestId("comments-toggle")).toHaveCount(0);
  await visitor.screenshot({ path: `${EVIDENCE}/comment-pins-visitor.png` });
  await Promise.all([oc.close(), vc.close()]);
});

// "Send to agent": the owner unticks the pin's box, the comment
// stays out of pi's view (bridge push and get_comments) and can be forwarded later; a ticked one reaches pi as before.
test("pin agent toggle: an unticked owner comment does not reach pi until forwarded; a ticked one does", async ({ browser }) => {
  const name = uniq("pinagent");
  await publish(name, "tests/fixtures/hello", "pin agent v1");
  const pi = await startBridge({ stateFile: path.join(ROOT, "test-results", `${name}.state.json`) });
  expect(await pi.follow(name)).toBe(`following ${name}`);
  const mcp = await mcpClient();
  const oc = await ownerContext(browser), owner = await oc.newPage();
  await owner.goto(`${APP}/v/${name}`);
  const O = frame(owner);
  await expect(O.getByTestId("heading")).toHaveText("Hello World");
  await expect.poll(() => pi.statuses.at(-1)).toMatch(/following/);
  const pinComment = async (text, agent) => {
    await owner.getByTestId("comment-mode").click();
    await O.getByTestId("heading").click();
    const pin = owner.getByTestId("comment-pin");
    await expect(pin.getByTestId("comment-pin-agent")).toBeChecked(); // default on
    if (!agent) await pin.getByTestId("comment-pin-agent").uncheck();
    await pin.getByTestId("comment-pin-input").fill(text);
    if (!agent) await owner.screenshot({ path: `${EVIDENCE}/pin-agent-unticked.png` });
    await pin.getByTestId("comment-pin-send").click();
    return owner.locator('[data-testid="thread"]', { hasText: text });
  };

  // unticked: stored with forPi: false, not for pi in the shell, nothing pushed, nothing in get_comments
  const held = await pinComment("HELD: just a note to self", false);
  await expect(held).toHaveAttribute("data-for-pi", "false");
  await expect(held.getByTestId("comment-forward")).toBeVisible();
  const stored = (await roomHistory(owner, name)).filter((m) => m.type === "comment");
  expect(stored).toMatchObject([{ from: "owner", forPi: false, text: "> Hello World\n\nHELD: just a note to self" }]);
  await owner.waitForTimeout(1000);
  expect(pi.messages.length).toBe(0);
  expect(await mcp.tool("get_comments", { name })).toEqual([]);
  // the Comments panel's box works the same way (the panel is open after a pinned comment)
  await expect(owner.getByTestId("comment-agent")).toBeChecked();
  await owner.getByTestId("comment-agent").uncheck();
  await owner.getByTestId("comment-input").fill("PANEL: also just for me");
  await owner.getByTestId("comment-send").click();
  await expect(owner.locator('[data-testid="thread"]', { hasText: "PANEL: also just for me" })).toHaveAttribute("data-for-pi", "false");

  // ticked (the default): reaches pi as today
  const sent = await pinComment("SENT: make it blue", true);
  await expect(sent).toHaveAttribute("data-for-pi", "true");
  await expect.poll(() => pi.messages.length, { timeout: 5000 }).toBe(1);
  expect(pi.messages[0].text).toContain("SENT: make it blue");
  expect(pi.messages[0].text).not.toMatch(/HELD|PANEL/);

  // the held one can be forwarded later, like a guest's; then pi gets it (by the owner: the bridge names no one)
  await held.getByTestId("comment-forward").click();
  await expect(held).toHaveAttribute("data-for-pi", "true");
  await expect.poll(() => pi.messages.length, { timeout: 5000 }).toBe(2);
  expect(pi.messages[1].text).toMatch(/by the owner \(on v1\): ".*HELD: just a note to self"/);
  expect((await mcp.tool("get_comments", { name })).map((c) => c.text)).toEqual(["> Hello World\n\nSENT: make it blue", "> Hello World\n\nHELD: just a note to self"]);
  await owner.screenshot({ path: `${EVIDENCE}/pin-agent-forwarded.png` });
  pi.stop();
  await Promise.all([mcp.close(), oc.close()]);
});
