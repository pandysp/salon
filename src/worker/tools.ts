// Tools: The owner's MCP server config, the egress allowlist derived from it, token encryption, and the MCP client calls.
// Used only by the Platform object (platform.ts), which owns the connections table and serialises calls per connection.
//  - The MCP servers (and every host the platform may contact for them) come from the owner's config (env MCP_SERVERS, a JSON
//    file mounted by scripts/up.sh), never from a manifest: a manifest only names a server.
//  - The allowlist is that config: each server's own origin plus its declared OAuth origins. `gatewayFetch` is the only fetch
//    the MCP SDK gets (transport + OAuth discovery/registration/token); anything else is refused before a socket opens. celld
//    has no SSRF guard of its own (W2b: loopback, tailnet and celld's own port are all reachable), so this check is the guard.
//  - Redirects are never followed automatically (redirect: "manual"): a 3xx to another host cannot slip past the allowlist.
//  - Tokens are stored AES-256-GCM encrypted (key from TOKEN_KEY, read from a secret file outside the data volume), with the
//    row's (subject, server) as additional data so a ciphertext cannot be moved to another row.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";

export type ServerConfig = { name: string; url: string; auth: "none" | "oauth"; origins: string[] };

// the owner's config: { "<server>": { "url": "https://…/mcp", "auth": "none" | "oauth", "oauthOrigins"?: ["https://…"] } }
// oauthOrigins: the other origins its OAuth flow needs (authorization server metadata, registration, token, the browser's
// authorization page). Scopes come from the server's own metadata (scopes_supported; the SDK picks them).
export function loadServers(raw: string | undefined): Map<string, ServerConfig> {
  if (!raw) throw new Error("MCP_SERVERS is not configured (see infra/*.mcp.json)");
  const cfg = JSON.parse(raw), out = new Map<string, ServerConfig>();
  for (const [name, s] of Object.entries<any>(cfg)) {
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(name)) throw new Error(`MCP_SERVERS: bad server name ${name}`);
    const url = new URL(s.url);
    if (s.auth !== "none" && s.auth !== "oauth") throw new Error(`MCP_SERVERS.${name}: auth must be none | oauth`);
    const extra = (s.oauthOrigins ?? []).map((o: string) => { const u = new URL(o); if (u.origin !== o) throw new Error(`MCP_SERVERS.${name}: ${o} is not an origin`); return o; });
    out.set(name, { name, url: url.href, auth: s.auth, origins: [url.origin, ...extra] });
  }
  return out;
}

export class EgressDenied extends Error {}
export function gatewayFetch(server: ServerConfig, denied: (origin: string) => void): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)); // the SDK passes a URL or a string; anything else throws here (fails closed)
    if (!server.origins.includes(url.origin)) {
      denied(url.origin);
      throw new EgressDenied(`egress to ${url.origin} is not allowed for MCP server "${server.name}"`);
    }
    // M1 (pre-Funnel review): one deadline per request, so a hanging server fails as an upstream error instead of holding its
    // (subject, server) queue forever. Tested for a server that never sends headers; that it also ends a body stalled after the
    // headers is the fetch signal's contract, not tested here
    const signal = AbortSignal.any([init?.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)].filter((x): x is AbortSignal => !!x));
    return capped(await fetch(input, { ...init, redirect: "manual", signal }), url.origin);
  }) as typeof fetch;
}
// One answer from a configured server (MCP or OAuth) is read up to MAX_RESPONSE_BYTES, then the read fails, so a broken or hostile
// server cannot fill the platform's memory: a 500 MB answer had Docker kill the container (pre-Funnel review P2).
// The error reaches the caller like any upstream failure (upstream_error, or 502 in the OAuth steps). celld
// may keep reading past the cap and drop the rest (aborting the fetch does not stop that): a server can waste bandwidth, not
// memory.
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
function capped(res: Response, origin: string) {
  if (!res.body) return res;
  let n = 0;
  const count = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctl) { n += chunk.byteLength; if (n > MAX_RESPONSE_BYTES) ctl.error(new Error(`answer from ${origin} is over ${MAX_RESPONSE_BYTES} bytes`)); else ctl.enqueue(chunk); },
  });
  const out = new Response(res.body.pipeThrough(count), { status: res.status, statusText: res.statusText, headers: res.headers });
  return Object.defineProperty(out, "url", { value: res.url }); // the SDK resolves a redirect's location against it
}

// ---- encryption at rest ----
const enc = new TextEncoder(), dec = new TextDecoder();
let keyPromise: Promise<CryptoKey> | null = null;
function tokenKey(env: { TOKEN_KEY?: string }) {
  return (keyPromise ??= (async () => {
    const b = env.TOKEN_KEY ? Uint8Array.from(atob(env.TOKEN_KEY.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)) : null;
    if (!b || b.length !== 32) throw new Error("TOKEN_KEY must be 32 bytes, base64 (scripts/up.sh creates the key file)");
    return crypto.subtle.importKey("raw", b, "AES-GCM", false, ["encrypt", "decrypt"]);
  })());
}
export async function seal(env: any, value: unknown, aad: string): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, await tokenKey(env), enc.encode(JSON.stringify(value))));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv); out.set(ct, 12);
  return out;
}
export async function unseal(env: any, blob: ArrayBuffer | Uint8Array, aad: string): Promise<any> {
  const b = new Uint8Array(blob);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b.slice(0, 12), additionalData: enc.encode(aad) }, await tokenKey(env), b.slice(12));
  return JSON.parse(dec.decode(pt));
}

// ---- the MCP client (official SDK) ----
// The connection state the provider reads and writes; persisted (encrypted) by the caller after every change.
export type ConnState = { client?: any; tokens?: any; verifier?: string; state?: string; stateExp?: number; returnTo?: string };
// the SDK's OAuth flow through the allowlisted fetch: without a code it registers (DCR) and asks for a redirect ("REDIRECT"),
// with the code from the callback it exchanges it for tokens ("AUTHORIZED")
export const authorize = (p: OAuthClientProvider, server: ServerConfig, fetchFn: typeof fetch, authorizationCode?: string) =>
  auth(p, { serverUrl: server.url, fetchFn, ...(authorizationCode ? { authorizationCode } : {}) });
export function provider(redirectUrl: string, server: ServerConfig, st: ConnState, onChange: () => Promise<void>, onRedirect: (u: URL) => void): OAuthClientProvider {
  return {
    get redirectUrl() { return redirectUrl; },
    get clientMetadata() {
      return { client_name: "Artifacts platform", redirect_uris: [redirectUrl], token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] };
    },
    state: () => st.state!, // some servers (Attio) refuse an authorization request without state; it also binds the callback
    clientInformation: () => st.client,
    saveClientInformation: async (c) => { st.client = c; await onChange(); },
    tokens: () => st.tokens,
    saveTokens: async (t) => { st.tokens = t; await onChange(); },
    redirectToAuthorization: (u) => onRedirect(u),
    saveCodeVerifier: async (v) => { st.verifier = v; await onChange(); },
    codeVerifier: () => { if (!st.verifier) throw new Error("no PKCE verifier for this connection"); return st.verifier; },
    invalidateCredentials: async (scope) => {
      if (scope === "all" || scope === "client") delete st.client;
      if (scope === "all" || scope === "tokens") delete st.tokens;
      if (scope === "all" || scope === "verifier") delete st.verifier;
      await onChange();
    },
  };
}

// One MCP session per call: connect, check that the server marks the tool read-only, call it, close.
export async function callMcp(server: ServerConfig, fetchFn: typeof fetch, auth: OAuthClientProvider | undefined, tool: string, args: Record<string, unknown>) {
  const transport = new StreamableHTTPClientTransport(new URL(server.url), { fetch: fetchFn, ...(auth ? { authProvider: auth } : {}) });
  const client = new Client({ name: "artifacts-platform", version: "1" });
  await client.connect(transport);
  try {
    const listed = (await client.listTools()).tools.find((t) => t.name === tool);
    if (!listed) return { ok: false as const, error: "unknown_tool", message: `server "${server.name}" has no tool "${tool}"` };
    // v1 allows read-only tools only, and "read-only" is what the MCP server says, not what the manifest says
    if (listed.annotations?.readOnlyHint !== true) return { ok: false as const, error: "not_read_only", message: `"${tool}" is not marked readOnlyHint by its server` };
    const result = await client.callTool({ name: tool, arguments: args });
    return { ok: !result.isError, result: { content: result.content, ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}) } };
  } finally {
    await client.close().catch((e) => console.log(`mcp close ${server.name}: ${e}`)); // the call itself already succeeded or failed
  }
}
