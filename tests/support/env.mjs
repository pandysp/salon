// Shared test helpers. The hostnames and owner login must match the stack's
// config (infra/local.env); switching to the real *.ts.net names is a config change there and here (env vars).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { bundleArtifact } from "../../lib/bundle-artifact.mjs";

export const PROXY_PORT = Number(process.env.CORE_PROXY_PORT ?? 8340);
export const UPSTREAM_PORT = Number(process.env.CORE_UPSTREAM_PORT ?? 8341);
export const TAILNET_PORT = PROXY_PORT + 2; // the test proxy's "every client is a tailnet device" door, for pi and its bridge
// chunk 3: the local container's name, the isolation test's canary, and the stack's MCP servers
export const STACK_NAME = process.env.CORE_STACK_NAME ?? "artifacts-local-app";
// the stack runs in its Docker container (else: native celld, e.g. tests/negative-controls.sh; a stopped container of the same name
// can sit beside it). One copy for tools.spec and review.spec
export const stackRunning = () => { try { return execFileSync("docker", ["inspect", "-f", "{{.State.Running}}", STACK_NAME], { encoding: "utf8" }).trim() === "true"; } catch { return false; } };
export const stackRestarts = () => (stackRunning() ? execFileSync("docker", ["inspect", "-f", "{{.RestartCount}}", STACK_NAME], { encoding: "utf8" }).trim() : "no running container (native celld)");
export const CANARY_PORT = PROXY_PORT + 4; // port layout: scripts/local-env.sh
export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
// the stack's config as scripts/local-env.sh renders it for this CORE_PROXY_PORT (the one renderer; it writes .run/local-<port>.env
// and .mcp.json and prints nothing else on stdout).
const [envFile, mcpFile] = execFileSync("bash", ["-c", ". scripts/local-env.sh && echo $LOCAL_ENV && echo $MCP_CONFIG"],
  { cwd: ROOT, encoding: "utf8", env: { ...process.env, CORE_PROXY_PORT: String(PROXY_PORT) } }).trim().split("\n");
const CONFIG = Object.fromEntries(fs.readFileSync(path.join(ROOT, envFile), "utf8").split("\n")
  .filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
export const MCP_SERVERS = JSON.parse(fs.readFileSync(path.join(ROOT, mcpFile), "utf8"));
export const APP = process.env.CORE_APP_ORIGIN ?? CONFIG.APP_ORIGIN;          // single source: infra/local.env
export const CONTENT = process.env.CORE_CONTENT_ORIGIN ?? CONFIG.CONTENT_ORIGIN;
export const OWNER_LOGIN = process.env.CORE_OWNER_LOGIN ?? CONFIG.OWNER_LOGINS.split(",")[0];
export const OWNER_NAME = CONFIG.OWNER_NAME; // the owner's display name (infra/local.env)
export const AGENT_TOKEN = process.env.CORE_AGENT_TOKEN ?? CONFIG.AGENT_TOKEN;
// Test runs write here (untracked).
export const EVIDENCE = process.env.CORE_EVIDENCE_DIR ?? path.join(ROOT, ".run/evidence");
fs.mkdirSync(EVIDENCE, { recursive: true });

export const tailnet = () => ({ "x-test-tailnet": process.env.TAILNET_TEST_SECRET });
export const uniq = (p) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
export const note = (file, data) => fs.writeFileSync(path.join(EVIDENCE, file), typeof data === "string" ? data : JSON.stringify(data, null, 2) + "\n");

// the owner's session, minted the way the shell does it: POST /api/signin/owner from the app origin, from the tailnet
let ownerCookie = null;
export async function ownerSession() {
  if (ownerCookie) return ownerCookie;
  const r = await fetch(APP + "/api/signin/owner", { method: "POST", headers: { ...tailnet(), origin: APP } });
  const c = /__Host-session=([^;]+)/.exec(r.headers.get("set-cookie") ?? "")?.[1];
  if (r.status !== 200 || !c) throw new Error(`owner sign-in failed: ${r.status} ${await r.text()}`);
  return (ownerCookie = `__Host-session=${c}`);
}
// API call as the owner's browser (session cookie + the app's Origin, as the shell sends them)
export async function ownerApi(p, body, headers = {}) {
  const auth = { cookie: await ownerSession(), origin: APP, ...tailnet() }; // the owner's device is on the tailnet
  const r = await fetch(APP + p, body === undefined ? { headers: { ...auth, ...headers } }
    : { method: "POST", headers: { "content-type": "application/json", ...auth, ...headers }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
// API call as pi on a tailnet device (bearer token, non-browser: no Origin). viaFunnel: the same from the public internet.
export async function agentApi(p, body, token = AGENT_TOKEN, { viaFunnel = false } = {}) {
  const h = { authorization: `Bearer ${token}`, ...(viaFunnel ? {} : tailnet()) };
  const r = await fetch(APP + p, body === undefined ? { headers: h } : { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
export const bundle = (dir, label) => bundleArtifact(path.join(ROOT, dir), { label });
export async function publish(name, dir, label, api = ownerApi) {
  const r = await api(`/api/artifacts/${name}/versions`, await bundle(dir, label));
  if (r.status !== 200) throw new Error(`publish ${name}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
// the owner's browser on a tailnet device: the tailnet header on every request, signed in once through the shell's owner button
export async function ownerContext(browser) {
  const ctx = await browser.newContext({ extraHTTPHeaders: tailnet() });
  const p = await ctx.newPage();
  await p.goto(APP + "/signin");
  await p.getByTestId("signin-owner").click();
  await p.waitForURL(APP + "/");
  await p.close();
  return ctx;
}

// a virtual platform authenticator (passkeys) on this page's target; pass credentials to restore a "device"
export async function authenticator(page, credentials = []) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  for (const c of credentials) await cdp.send("WebAuthn.addCredential", { authenticatorId, credential: c });
  return { credentials: async () => (await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials };
}
// owner creates an invite; a fresh browser registers a passkey through it and lands on the artifact
export async function inviteGuest(browser, artifact, name) {
  const inv = await ownerApi(`/api/artifacts/${artifact}/invites`, { label: name });
  if (inv.status !== 200) throw new Error("invite: " + JSON.stringify(inv));
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const auth = await authenticator(page);
  await page.goto(inv.body.url);
  await page.getByTestId("invite-accept").click();
  await page.waitForURL(`${APP}/v/${artifact}`);
  return { ctx, page, auth, inviteUrl: inv.body.url };
}
export const frame = (page) => page.frameLocator('[data-testid="artifact-frame"]');
// The viewer's Share (owner panel) and Comments panels are collapsed by default (shell restyle): open one before using its controls. Idempotent; tests check the same things as before.
const openPanel = async (page, toggle) => { const t = page.getByTestId(toggle); if ((await t.getAttribute("aria-expanded")) !== "true") await t.click(); };
export const openShare = (page) => openPanel(page, "share-toggle");
export const openComments = (page) => openPanel(page, "comments-toggle");

// Frame controls are driven by keyboard (locator.press focuses through the DOM, then sends keys to the focused frame):
// right after an out-of-process iframe loads, Chrome briefly routes mouse clicks to the parent page's <iframe> element
// so a click-based test is flaky by design.
