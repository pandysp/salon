// A stand-in for pi that loads the REAL bridge extension
// (integrations/pi/artifact-bridge.ts) with the parts of pi's extension API it uses (on, registerTool, sendUserMessage,
// appendEntry, ctx.sessionManager.getEntries, ctx.cwd, ctx.ui.setStatus), shapes as in pi 1.6.0 docs/extensions.md and
// docs/session-format.md. No model: the test plays pi's part.
// Also an MCP client (the official SDK) for the endpoint, as pi's own MCP client would call it.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ROOT, AGENT_TOKEN, TAILNET_PORT, APP } from "./env.mjs";

// pi runs on a tailnet device: it reaches the app host through the test proxy's tailnet door
export const PI_ORIGIN = APP.replace(/:\d+$/, `:${TAILNET_PORT}`);

// entries: the pi session's stored entries; pass the same array again to "resume" that session
export async function startBridge({ entries = [], stateFile, origin = PI_ORIGIN }) {
  process.env.ARTIFACTS_ORIGIN = origin;
  process.env.ARTIFACTS_AGENT_TOKEN = AGENT_TOKEN;
  process.env.ARTIFACTS_BRIDGE_STATE = stateFile;
  const { default: bridge } = await import("../../integrations/pi/artifact-bridge.ts");
  const handlers = {}, tools = {}, messages = [], statuses = [];
  bridge({
    on: (event, fn) => (handlers[event] = fn),
    registerTool: (t) => (tools[t.name] = t),
    sendUserMessage: (text, opts) => messages.push({ text, opts, at: Date.now() }),
    appendEntry: (customType, data) => entries.push({ type: "custom", id: String(entries.length), customType, data }),
  });
  const ctx = { cwd: ROOT, sessionManager: { getEntries: () => entries }, ui: { setStatus: (_k, t) => statuses.push(t) } };
  await handlers.session_start({ reason: entries.length ? "resume" : "startup" }, ctx);
  return {
    messages, entries, statuses, tools: Object.keys(tools),
    publish: async (name, dir) => JSON.parse((await tools.publish_artifact.execute("call-1", { name, dir }, undefined, undefined, ctx)).content[0].text),
    follow: async (name) => (await tools.follow_artifact.execute("call-1", { name }, undefined, undefined, ctx)).content[0].text,
    stop: () => handlers.session_shutdown({ reason: "quit" }, ctx),
  };
}

export async function mcpClient(token = AGENT_TOKEN, origin = PI_ORIGIN) {
  const c = new Client({ name: "loop-test", version: "1.0.0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(origin + "/api/mcp"), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  c.tool = async (name, args = {}) => {
    const r = await c.callTool({ name, arguments: args });
    if (r.isError) throw new Error(r.content[0].text);
    return JSON.parse(r.content[0].text);
  };
  return c;
}
