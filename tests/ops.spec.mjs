// DoD 1, local half: scripts/up.sh, down.sh, status.sh are idempotent and
// data survives down.sh && up.sh (local container stack). Runs last (project "ops"): it restarts the stack.
import { execFileSync } from "node:child_process";
import { test, expect } from "@playwright/test";
import { APP, ROOT, uniq, publish, ownerApi, ownerContext, frame, note } from "./support/env.mjs";

const container = () => execFileSync("docker", ["inspect", "-f", "{{.Id}} {{.Created}} {{.State.StartedAt}} {{.State.Status}}", process.env.CORE_STACK_NAME ?? "artifacts-local-app"], { encoding: "utf8" }).trim();
const run = (script) => {
  const t0 = Date.now();
  try { return { code: 0, out: execFileSync(`${ROOT}/scripts/${script}`, ["local"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), ms: Date.now() - t0 }; }
  catch (e) { return { code: e.status, out: String(e.stdout) + String(e.stderr), ms: Date.now() - t0 }; }
};
test.setTimeout(300_000);

test("DoD 1 (local): up/down/status idempotent, data survives down && up", async ({ browser }) => {
  const log = {};
  const name = uniq("ops");
  await publish(name, "artifacts/shared-list", "ops v1");
  const oc = await ownerContext(browser), p = await oc.newPage();
  await p.goto(`${APP}/v/${name}`);
  await frame(p).getByTestId("new-item-input").fill("survives restarts");
  await frame(p).getByTestId("new-item-input").press("Enter");
  await expect(frame(p).getByTestId("item-title")).toHaveText(["survives restarts"]);
  await oc.close();

  log.up1 = run("up.sh"); log.c1 = container();
  log.up2 = run("up.sh"); log.c2 = container();             // up twice: both succeed, each re-creates the container
  log.status = run("status.sh");
  log.down1 = run("down.sh"); log.down2 = run("down.sh");   // down twice: both succeed
  log.statusDown = run("status.sh");
  log.unreachableWhileDown = await fetch(APP + "/api/me").then((r) => r.status, (e) => "error: " + e.message);
  log.up3 = run("up.sh"); log.c3 = container();
  for (const k of ["up1", "up2", "status", "down1", "down2", "statusDown", "up3"]) expect(log[k].code, `${k}: ${log[k].out}`).toBe(0);
  expect(log.status.out).toContain("running");
  expect(log.status.out).toContain('platform /api/me -> {"kind":"public"');
  expect(log.statusDown.out).toContain("exited");
  const ids = [log.c1, log.c2, log.c3].map((c) => c.split(" ")[0]);
  expect(new Set(ids).size).toBe(3);                         // a new container each time (volumes keep the data)
  for (const c of [log.c1, log.c2, log.c3]) expect(c.endsWith(" running")).toBe(true);
  expect(log.unreachableWhileDown).not.toBe(200);

  const oc2 = await ownerContext(browser), p2 = await oc2.newPage();
  await p2.goto(`${APP}/v/${name}`);
  await expect(frame(p2).getByTestId("app-version")).toHaveText("ops v1");
  await expect(frame(p2).getByTestId("item-title")).toHaveText(["survives restarts"]);
  log.artifactAfter = (await ownerApi(`/api/artifacts/${name}`)).body.current_version;
  expect(log.artifactAfter).toBe(1);
  await oc2.close();
  note("dod1-ops-local.json", log);
});
