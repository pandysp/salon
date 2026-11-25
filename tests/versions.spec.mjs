// DoD 8: versions. Rollback to v1 restores v1's code and the room as of v1's
// seq; later messages move to the archive table. Viewers that are open follow live.
import { test, expect } from "@playwright/test";
import { APP, uniq, publish, ownerApi, ownerContext, frame, note, EVIDENCE } from "./support/env.mjs";

test("DoD 8: rollback restores v1's code and the room at v1's seq; later messages are archived", async ({ browser }) => {
  const name = uniq("ver");
  await publish(name, "artifacts/shared-list", "code v1");
  const oc = await ownerContext(browser), p = await oc.newPage();
  await p.goto(`${APP}/v/${name}`);
  const F = frame(p);
  await expect(F.getByTestId("status")).toHaveText("connected");
  const add = async (t) => { await F.getByTestId("new-item-input").fill(t); await F.getByTestId("new-item-input").press("Enter"); };
  await add("A"); await add("B");
  await expect(F.getByTestId("item-title")).toHaveText(["A", "B"]);

  const v2 = await publish(name, "artifacts/shared-list", "code v2"); // records room_seq = 2
  expect(v2).toEqual({ version: 2, room_seq: 2, approved: true }); // (chunk 3: no tools -> approved at publish)
  await expect(F.getByTestId("app-version")).toHaveText("code v2");
  await add("C");
  await F.getByTestId("item-toggle").first().press("Space"); // A done, after v2
  await expect(F.getByTestId("item-title")).toHaveText(["A", "B", "C"]);
  await expect(F.getByTestId("item-toggle").first()).toBeChecked();

  const rb = await ownerApi(`/api/artifacts/${name}/rollback`, { version: 1 });
  expect(rb.body).toEqual({ version: 3, restored_from: 1, room_seq: 0, archived: 4, restored: 0 });
  // the open viewer follows without a reload: v1's code, the room as it was when v1 was published (empty)
  await expect(p.getByTestId("artifact-version")).toHaveText("v3");
  await expect(F.getByTestId("app-version")).toHaveText("code v1");
  await expect(F.getByTestId("empty-state")).toBeVisible();

  const archive = (await ownerApi(`/api/artifacts/${name}/archive`)).body;
  expect(archive.map((m) => [m.seq, m.type, m.title ?? m.done, m.reason])).toEqual([
    [1, "add", "A", "rollback to v1"], [2, "add", "B", "rollback to v1"], [3, "add", "C", "rollback to v1"], [4, "set-done", true, "rollback to v1"],
  ]);
  const details = (await ownerApi(`/api/artifacts/${name}`)).body;
  expect(details.versions.map((v) => [v.version, v.room_seq, v.restored_from])).toEqual([[1, 0, null], [2, 2, null], [3, 0, 1]]);
  expect(details.versions.every((v) => typeof v.approved_at === "number")).toBe(true); // seam for chunk 3 (owner-query approval)
  await p.screenshot({ path: `${EVIDENCE}/dod8-after-rollback-to-v1.png` });

  // rolling forward to v2 undoes part of that: v2's code and the room at seq 2 (A, B come back from the archive; C and the
  // toggle stay archived). New messages get new seqs; old ones are never reused.
  const rb2 = await ownerApi(`/api/artifacts/${name}/rollback`, { version: 2 });
  expect(rb2.body).toEqual({ version: 4, restored_from: 2, room_seq: 2, archived: 0, restored: 2 });
  await expect(F.getByTestId("app-version")).toHaveText("code v2");
  await expect(F.getByTestId("item-title")).toHaveText(["A", "B"]);
  await expect(F.getByTestId("item-toggle").first()).not.toBeChecked();
  expect((await ownerApi(`/api/artifacts/${name}/archive`)).body.map((m) => m.seq)).toEqual([3, 4]);
  await add("D");
  await expect(F.getByTestId("item-title")).toHaveText(["A", "B", "D"]); // D went through the room (wait before reading it raw)
  const room = await p.evaluate(async (n) => {
    const ws = new WebSocket(`wss://${location.host}/api/rooms/${n}/app`);
    const h = await new Promise((r) => (ws.onmessage = (e) => r(JSON.parse(e.data))));
    ws.close(); return h.messages;
  }, name);
  expect(room.map((m) => [m.seq, m.title])).toEqual([[1, "A"], [2, "B"], [5, "D"]]);
  // reload: same state from storage
  await p.reload();
  await expect(F.getByTestId("app-version")).toHaveText("code v2");
  await expect(F.getByTestId("item-title")).toHaveText(["A", "B", "D"]);
  note("dod8-versions.json", { artifact: name, v2, rollbackToV1: rb.body, archive, versions: details.versions.map(({ manifest, ...v }) => v), rollbackToV2: rb2.body, roomAfter: room });
  await oc.close();
});
