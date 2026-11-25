// Starts the test-only tailnet proxy (fresh secret per run) and checks that
// the stack answers behind it. Fails fast with a hint if it does not.
import crypto from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { startTailnetProxy } from "./tailnet-proxy.mjs";
import { PROXY_PORT, UPSTREAM_PORT, TAILNET_PORT, OWNER_LOGIN, APP, CONTENT, ROOT, EVIDENCE, MCP_SERVERS } from "./env.mjs";

// the test MCP servers of this stack's MCP config (the ones on
// servers named studio and items: the Studio stand-in and the OAuth items server). Their call logs go to the run evidence dir.
// Access tokens of the OAuth server live 20 s, so the tools test sees a refresh.
const FIXTURES = {
  studio: (u) => ["tests/fixtures/mcp-studio/server.mjs", [u.port, "127.0.0.1"], {}],
  items: (u) => ["tests/fixtures/mcp-oauth/server.mjs", [], { MCP_BASE: u.origin, ACCESS_TTL_S: "20", MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL: "1" }],
};
async function startMcpFixtures() {
  const kids = [];
  fs.mkdirSync(path.join(ROOT, ".run"), { recursive: true });
  for (const [name, s] of Object.entries(MCP_SERVERS)) {
    const u = new URL(s.url);
    const fixture = FIXTURES[name];
    if (!fixture) continue; // other servers (rogue: started by its own test; attio: the real one)
    const log = path.join(EVIDENCE, `mcp-${name}-calls.jsonl`);
    fs.writeFileSync(log, "");
    const out = fs.openSync(path.join(ROOT, `.run/mcp-${name}.log`), "w");
    const [script, args, env] = fixture(u);
    const kid = spawn(process.execPath, [path.join(ROOT, script), ...args], { env: { ...process.env, ...env, MCP_LOG: log }, stdio: ["ignore", out, out] });
    kids.push(kid);
    let up = false;
    for (let i = 0; i < 40 && !up && kid.exitCode === null; i++) {
      up = await fetch(`http://127.0.0.1:${u.port}/mcp`).then(() => true, () => false);
      if (!up) await new Promise((r) => setTimeout(r, 250));
    }
    if (!up) { kids.forEach((k) => k.kill()); throw new Error(`test MCP server ${name} did not start on :${u.port} (port taken?); see .run/mcp-${name}.log`); }
  }
  return kids;
}

export default async function globalSetup() {
  // the local hosts are public DNS names (same site, like production); never send the tailnet marker or cookies elsewhere
  for (const o of [APP, CONTENT]) {
    const h = new URL(o).hostname, a = await dns.lookup(h, { all: true }).catch((e) => [{ address: String(e) }]);
    if (!a.length || a.some((x) => x.address !== "127.0.0.1" && x.address !== "::1")) throw new Error(`${h} must resolve to loopback only, got ${JSON.stringify(a)}`);
  }
  const secret = crypto.randomBytes(18).toString("base64url");
  process.env.TAILNET_TEST_SECRET = secret; // inherited by the test workers
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // Node-side requests to the test proxy's self-signed cert (tests only)
  const server = await startTailnetProxy({ port: PROXY_PORT, upstreamPort: UPSTREAM_PORT, ownerLogin: OWNER_LOGIN, secret, tailnetPort: TAILNET_PORT });
  const kids = await startMcpFixtures().catch((e) => { server.close(); throw e; });
  const r = await fetch(APP + "/api/signin/owner", { method: "POST", headers: { "x-test-tailnet": secret, origin: APP } })
    .then(async (x) => `${x.status} ${await x.text()}`).catch((e) => String(e));
  if (!r.startsWith("200")) {
    server.close(); kids.forEach((k) => k.kill());
    throw new Error(`stack not reachable or misconfigured behind the test proxy (127.0.0.1:${UPSTREAM_PORT}); owner sign-in -> ${r}. Start it with scripts/up.sh local.`);
  }
  // Synchronous on purpose: an async teardown awaiting server.close() never resolved (upgraded WebSocket sockets), Node then
  // ran out of work and exited 0 mid-teardown, which dropped Playwright's failure output and summary.
  return () => { server.close(); server.closeAllConnections(); kids.forEach((k) => k.kill()); };
}
