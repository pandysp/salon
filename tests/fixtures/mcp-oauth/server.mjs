// A local MCP server (Streamable HTTP) with its own tiny OAuth authorization server; users alice/bob.
// Changed: base URL, port and token lifetime from the environment; issued tokens carry a recognisable prefix
// (KNOWNTOKEN-<kind>-<user>-…) so the tests can grep the platform's data volume for them; test hook GET /admin/issued lists them;
// only the read-only list_my_items tool and no revoke hook (the tests use neither add_item nor revocation).
// Usage: MCP_BASE=http://oauth-mcp.localtest.me:8362 [ACCESS_TTL_S=3600] [MCP_LOG=file] node server.mjs
// The base is a name that resolves to this machine for the browser (public DNS: *.localtest.me -> 127.0.0.1) and for the
// platform container (docker --add-host <name>:host-gateway); the issuer is plain http, so the SDK needs
// MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL=1 (test only).
import express from "express";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { InvalidTokenError, InvalidGrantError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";

const BASE = process.env.MCP_BASE ?? "http://127.0.0.1:8200";
const PORT = Number(new URL(BASE).port);
const ACCESS_TTL_S = Number(process.env.ACCESS_TTL_S ?? 3600);
const LOG = process.env.MCP_LOG ?? "/dev/null";
const log = (o) => appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), ...o }) + "\n");
const PW = { alice: "alice-pw", bob: "bob-pw" };
const ITEMS = { alice: [{ id: 1, name: "alice's passport" }, { id: 2, name: "alice's tax return" }], bob: [{ id: 1, name: "bob's bike" }] };

const clients = new Map(), codes = new Map(), access = new Map(), refresh = new Map(), issued = [];
const clientsStore = {
  getClient: (id) => clients.get(id),
  registerClient: (c) => { const full = { ...c, client_id: randomUUID(), client_id_issued_at: Math.floor(Date.now() / 1000) }; clients.set(full.client_id, full); return full; },
};
const issue = (user, client_id, scopes, resource) => {
  const a = `KNOWNTOKEN-access-${user}-${randomUUID()}`, r = `KNOWNTOKEN-refresh-${user}-${randomUUID()}`;
  access.set(a, { user, client_id, scopes, exp: Date.now() + ACCESS_TTL_S * 1000, resource });
  refresh.set(r, { user, client_id, scopes, resource });
  issued.push(a, r);
  log({ user, event: "tokens-issued" });
  return { access_token: a, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: r, scope: scopes.join(" ") };
};
const provider = {
  clientsStore,
  async authorize(client, params, res) {
    const q = new URLSearchParams({ client_id: client.client_id, redirect_uri: params.redirectUri, challenge: params.codeChallenge, state: params.state ?? "", resource: params.resource?.href ?? "" });
    res.type("html").send(`<form method=post action="/login?${q}"><h1>Sign in to the items MCP server</h1>
      <input name=user placeholder=user><input name=pw type=password placeholder=password><button>Sign in</button></form>`);
  },
  async challengeForAuthorizationCode(_c, code) { return codes.get(code).challenge; },
  async exchangeAuthorizationCode(client, code) { const c = codes.get(code); codes.delete(code); return issue(c.user, client.client_id, c.scopes, c.resource); },
  async exchangeRefreshToken(client, rt) { const r = refresh.get(rt); if (!r) throw new InvalidGrantError("invalid refresh token"); refresh.delete(rt); log({ user: r.user, event: "refresh" }); return issue(r.user, client.client_id, r.scopes, r.resource); },
  async verifyAccessToken(t) {
    const a = access.get(t); if (!a || a.exp < Date.now()) throw new InvalidTokenError("unknown token");
    return { token: t, clientId: a.client_id, scopes: a.scopes, expiresAt: Math.floor(a.exp / 1000), extra: { user: a.user } };
  },
  async revokeToken(_c, { token }) { access.delete(token); refresh.delete(token); },
};

const app = express();
app.use(mcpAuthRouter({ provider, issuerUrl: new URL(BASE), resourceServerUrl: new URL(BASE + "/mcp"), scopesSupported: ["items"] }));
app.post("/login", express.urlencoded({ extended: false }), (req, res) => {
  const { user, pw } = req.body;
  if (PW[user] !== pw) return res.status(401).send("bad login");
  const { redirect_uri, state, challenge, resource } = req.query;
  const code = randomUUID(); codes.set(code, { user, challenge, scopes: ["items"], resource });
  const u = new URL(redirect_uri); u.searchParams.set("code", code); if (state) u.searchParams.set("state", state);
  res.redirect(u.href);
});
// test hook: every token ever issued (for the data-volume grep)
app.get("/admin/issued", (_req, res) => res.json(issued));

const bearer = requireBearerAuth({ verifier: provider, requiredScopes: ["items"], resourceMetadataUrl: BASE + "/.well-known/oauth-protected-resource/mcp" });
app.post("/mcp", bearer, express.json(), async (req, res) => {
  const user = req.auth.extra.user;
  const server = new McpServer({ name: "items", version: "1.0.0" });
  server.registerTool("list_my_items", { description: "List the caller's items", annotations: { readOnlyHint: true } }, async () => {
    log({ user, tool: "list_my_items" });
    return { content: [{ type: "text", text: JSON.stringify(ITEMS[user]) }] };
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
app.all("/mcp", (_req, res) => res.status(405).set("allow", "POST").send("method not allowed")); // GET probes for an SSE stream
app.listen(PORT, "127.0.0.1", () => console.log("mcp on", BASE, "access ttl", ACCESS_TTL_S));
