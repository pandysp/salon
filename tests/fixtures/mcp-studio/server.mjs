// The stand-in for "a read-only private MCP server on the Studio" (use case A). Changed: tools carry
// annotations.readOnlyHint (the platform calls only tools the server marks read-only), GET answers 405 (Streamable HTTP clients
// may probe for an SSE stream), an optional call log (names only); W2b's shared-secret header check removed (v1 does not use it).
// Read-only MCP server (streamable HTTP, JSON responses only). Tools: uptime, sw_vers, list_scratch (folder names only).
// Fixed argv, no user input reaches a shell.
// Usage: [MCP_LOG=file] [MCP_TOOLS=uptime,sw_vers] node server.mjs <port> <bindaddr>...
// MCP_TOOLS: serve only these tools, e.g. for chunk 1's tailnet run, where
// list_scratch (folder names can name clients) and touch_marker are not wanted. Unset = all four (the tests use all four).
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import { execFile } from "node:child_process";

const [port, ...binds] = process.argv.slice(2);
const callLog = (o) => process.env.MCP_LOG && fs.appendFileSync(process.env.MCP_LOG, JSON.stringify({ t: new Date().toISOString(), ...o }) + "\n");

const run = (cmd, args) => new Promise((res, rej) => execFile(cmd, args, { timeout: 5000 }, (e, out) => e ? rej(e) : res(out.trim())));
const TOOLS = {
  uptime: { description: "Output of `uptime`", fn: () => run("/usr/bin/uptime", []) },
  sw_vers: { description: "Output of `sw_vers`", fn: () => run("/usr/bin/sw_vers", []) },
  list_scratch: { description: "Folder NAMES in the temp dir (names only)", fn: async () => fs.readdirSync(os.tmpdir(), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort().join("\n") },
  // a tool that is NOT marked read-only: the platform must refuse to call it
  touch_marker: { description: "Writes nothing; declared without readOnlyHint for the platform's read-only check", readOnly: false, fn: async () => "should never run" },
};
if (process.env.MCP_TOOLS) {
  const keep = process.env.MCP_TOOLS.split(",");
  for (const n of keep) if (!TOOLS[n]) throw new Error(`MCP_TOOLS names unknown tool "${n}" (known: ${Object.keys(TOOLS).join(", ")})`);
  for (const n of Object.keys(TOOLS)) if (!keep.includes(n)) delete TOOLS[n];
}

async function rpc(msg) {
  const id = msg.id;
  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  const err = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
  switch (msg.method) {
    case "initialize": return ok({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "studio-readonly", version: "0.1.0" } });
    case "notifications/initialized": return null;
    case "tools/list": return ok({ tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: t.readOnly !== false } })) });
    case "tools/call": {
      const t = TOOLS[msg.params?.name];
      if (!t) return err(-32602, "unknown tool");
      callLog({ tool: msg.params.name });
      try { return ok({ content: [{ type: "text", text: await t.fn() }] }); } catch (e) { return err(-32000, String(e.message)); }
    }
    default: return err(-32601, "method not found");
  }
}

async function handler(req, res) {
  const log = (s) => console.log(new Date().toISOString(), req.socket.remoteAddress, "->", req.headers.host, req.method, req.url, s, "headers=[" + Object.keys(req.headers).join(",") + "]"); // names only, never values
  if (req.url === "/mcp" && req.method !== "POST") { log("405"); res.writeHead(405, { allow: "POST" }).end("method not allowed"); return; }
  if (req.url !== "/mcp") { log("404"); res.writeHead(404).end("not found"); return; }
  let body = ""; for await (const c of req) body += c;
  let msg; try { msg = JSON.parse(body); } catch { log("400"); res.writeHead(400).end("bad json"); return; }
  const out = await rpc(msg);
  log("200 " + msg.method + (msg.params?.name ? ":" + msg.params.name : ""));
  if (out === null) { res.writeHead(202).end(); return; }
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
}

// One listener per bind address (loopback first, then e.g. the tailnet IP).
for (const b of binds) http.createServer(handler).listen(Number(port), b, () => console.log("listening", b + ":" + port));
