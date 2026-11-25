// pi bridge to the artifacts platform. Modelled on the authoring-loop spike's .pi/extensions/artifact-bridge.ts (W2c), which
// was modelled on plannotator/artifact-server integrations/pi; own code.
//
// What it does:
//  - publish_artifact {name, dir}: builds <dir> locally (lib/bundle-artifact.mjs: Solid 2 main.jsx or a static folder) and
//    publishes it through the platform's MCP endpoint (POST <origin>/api/mcp, tool publish_artifact). The session then follows
//    that artifact.
//  - follow_artifact {name}: the session follows an existing artifact without republishing it (same state as after a
//    publish, so comments it missed replay).
//  - for every artifact this session follows: joins its comments room as pi (bearer token). The room sends pi only its gated
//    view (the owner's comments and the ones he forwarded; src/worker/comments.js agentItems) on connect and after every change.
//    Open threads with a seq above the last delivered one are injected as one follow-up user message; then the seq is saved.
//  - the last delivered seq per (origin, artifact) lives in a small JSON file next to this extension (or ARTIFACTS_BRIDGE_STATE),
//    shared by all pi sessions of this install; so a comment made while pi was offline arrives when a session follows the
//    artifact again (reconnect, restart, resume, or a fresh session that republishes or follows it). Delivery is at least once.
//  - which artifacts a session follows is stored in the session itself (appendEntry "artifact-follow"), so a resumed session
//    follows them again and parallel sessions don't all receive every comment.
// The other tools (list_artifacts, get_comments, reply_comment, resolve_comment) come straight from the MCP endpoint through
// pi's own MCP client (.pi/mcp.json or ~/.pi/agent/mcp.json, see README.md).
//
// Config (environment, read at session start):
//   ARTIFACTS_ORIGIN       app host origin, e.g. https://artifacts-app.<tailnet>.ts.net
//   ARTIFACTS_AGENT_TOKEN  the platform's AGENT_TOKEN (same variable the MCP config uses for its Authorization header)
//   ARTIFACTS_BRIDGE_STATE optional path of the state file (default: artifact-bridge.state.json next to this file)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundleArtifact } from "../../lib/bundle-artifact.mjs";

type Item = { id: string; text: string; from: string; version: number | null; seq: number; forwarded: boolean; resolved: boolean };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FOLLOW = "artifact-follow";

export default function artifactBridge(pi: any) {
  let cfg: { origin: string; token: string; stateFile: string } | null = null;
  let ctx: any = null, stopped = true;
  const sockets = new Map<string, WebSocket>();

  const config = () => {
    if (cfg) return cfg;
    const origin = process.env.ARTIFACTS_ORIGIN?.replace(/\/+$/, ""), token = process.env.ARTIFACTS_AGENT_TOKEN;
    if (!origin || !token) throw new Error("artifact-bridge: set ARTIFACTS_ORIGIN and ARTIFACTS_AGENT_TOKEN");
    return (cfg = { origin, token, stateFile: process.env.ARTIFACTS_BRIDGE_STATE ?? path.join(HERE, "artifact-bridge.state.json") });
  };
  const status = (text: string) => ctx?.ui?.setStatus?.("artifacts", text);

  // ---- state file: { "<origin>": { "<artifact>": lastDeliveredSeq } }; re-read before every write (other sessions share it) ----
  const readState = () => {
    const f = config().stateFile;
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
  };
  const lastSeq = (name: string): number => readState()[config().origin]?.[name] ?? 0;
  const saveSeq = (name: string, seq: number) => {
    const s = readState(), o = (s[config().origin] ??= {});
    if ((o[name] ?? 0) >= seq) return;
    o[name] = seq;
    const tmp = `${config().stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n");
    fs.renameSync(tmp, config().stateFile); // atomic: a crash never leaves half a file
  };

  // ---- MCP call (stateless JSON-RPC, as pi's MCP client speaks it) ----
  async function mcp(tool: string, args: object) {
    const { origin, token } = config();
    const r = await fetch(`${origin}/api/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
    });
    if (!r.ok) throw new Error(`artifacts MCP: HTTP ${r.status} ${await r.text()}`);
    const j: any = await r.json();
    if (j.error) throw new Error(`artifacts MCP: ${j.error.message}`);
    const text = j.result.content[0].text;
    if (j.result.isError) throw new Error(text);
    return JSON.parse(text);
  }

  // ---- delivery: everything open above the last delivered seq, as one follow-up message; then save the seq ----
  function deliver(name: string, items: Item[]) {
    const last = lastSeq(name), fresh = items.filter((t) => t.seq > last);
    if (!fresh.length) return;
    const open = fresh.filter((t) => !t.resolved);
    if (open.length) {
      const lines = open.map((t) => t.from === "owner"
        ? `- comment ${t.id} by the owner${t.version ? ` (on v${t.version})` : ""}: ${JSON.stringify(t.text)}`
        : `- comment ${t.id} by a guest (${t.from}), forwarded to you by the owner${t.version ? ` (on v${t.version})` : ""}: ${JSON.stringify(t.text)}`);
      pi.sendUserMessage(
        `[artifact comments] New comment${open.length > 1 ? "s" : ""} on artifact "${name}":\n${lines.join("\n")}\n\n` +
        `For each: make the change in the artifact's source, republish it with publish_artifact (same name), then reply_comment ` +
        `(say what you changed) and resolve_comment with its id (artifacts MCP tools).`,
        { deliverAs: "followUp" });
    }
    saveSeq(name, Math.max(...fresh.map((t) => t.seq)));
  }

  // ---- one comments-room socket per followed artifact; reconnects; the server's history frame replays what was missed ----
  function follow(name: string, persist: boolean) {
    if (sockets.has(name) || stopped) return;
    if (persist) pi.appendEntry(FOLLOW, { name });
    const { origin, token } = config();
    const connect = () => {
      if (stopped || !sockets.has(name)) return;
      const ws = new WebSocket(`${origin.replace(/^http/, "ws")}/api/rooms/${encodeURIComponent(name)}/comments`, { headers: { authorization: `Bearer ${token}` } } as any);
      sockets.set(name, ws);
      ws.onopen = () => status(`artifacts: following ${[...sockets.keys()].join(", ")}`);
      ws.onmessage = (e) => {
        const m = JSON.parse(String(e.data));
        if (m.type === "history") deliver(name, m.messages);
      };
      ws.onclose = (e) => {
        if (stopped || sockets.get(name) !== ws) return;
        status(`artifacts: ${name} disconnected (${e.code}${e.reason ? " " + e.reason : ""}), retrying`);
        setTimeout(connect, 2000);
      };
    };
    sockets.set(name, null as any);
    connect();
  }

  pi.on("session_start", (_event: any, c: any) => {
    ctx = c; stopped = false;
    const names = new Set<string>();
    for (const e of c.sessionManager.getEntries()) if (e.type === "custom" && e.customType === FOLLOW && e.data?.name) names.add(e.data.name);
    for (const n of names) follow(n, false);
  });
  pi.on("session_shutdown", () => {
    stopped = true;
    for (const ws of sockets.values()) ws?.close();
    sockets.clear();
  });

  pi.registerTool({
    name: "publish_artifact",
    label: "Publish artifact",
    description: "Build an artifact folder locally and publish it as the next version of artifact <name> on the artifacts platform " +
      "(new artifacts start private). Open viewers switch to the new version live. <dir> holds manifest.json ({title}) and either " +
      "main.jsx (Solid 2; load nothing else, the page talks to the platform only through window.artifact, the SDK) plus optional " +
      "style.css, or a static index.html with its files. Afterwards this session receives the owner's comments on it.", // no name here: the bridge has no OWNER_NAME
    parameters: { type: "object", required: ["name", "dir"], properties: {
      name: { type: "string", description: "artifact name: lowercase letters, digits, dashes; reuse it to update the same URL" },
      dir: { type: "string", description: "folder with manifest.json and main.jsx (or index.html), relative to the working directory" } } },
    async execute(_id: string, p: any, _signal: any, _onUpdate: any, c: any) {
      const payload = await bundleArtifact(path.resolve(c?.cwd ?? process.cwd(), p.dir), { label: `${p.name} ${new Date().toISOString()}` });
      const r = await mcp("publish_artifact", { name: p.name, ...payload });
      follow(p.name, true);
      return { content: [{ type: "text", text: JSON.stringify(r) }], details: r };
    },
  });

  pi.registerTool({
    name: "follow_artifact",
    label: "Follow artifact",
    description: "Start receiving the owner's comments on an existing artifact <name> in this session, without republishing it " +
      "(e.g. to take over a page another or an earlier session published). Comments nobody has received yet arrive right away.",
    parameters: { type: "object", required: ["name"], properties: { name: { type: "string", description: "artifact name, as in list_artifacts" } } },
    async execute(_id: string, p: any) {
      await mcp("get_comments", { name: p.name, status: "all" }); // fails loudly (404) for an artifact that does not exist
      follow(p.name, true);
      return { content: [{ type: "text", text: `following ${p.name}` }], details: { name: p.name } };
    },
  });
}
