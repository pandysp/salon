// The authoring MCP endpoint for pi: POST /api/mcp on the app host, agent bearer token only, tailnet only (index.ts checks
// both before calling this). Minimal stateless MCP over streamable HTTP with JSON responses,
// checked with the official SDK client and with
// pi's own MCP client (tests/loop.spec.mjs). Every tool is a thin call into what already exists: Platform.publish /
// listFor / access, and the comments room's postComment / agentView (the gate in comments.js).
import { UserError, ownerName, type Platform } from "./platform";
import { readJson } from "./body";

const s = (description: string) => ({ type: "string", description });
const tools = (owner: string) => [ // owner: ownerName(env)
  {
    name: "publish_artifact",
    description: "Publish a bundle as the next version of artifact <name> (created private if new). Open viewers switch to it live. " +
      "pi's artifact-bridge extension wraps this tool and builds the bundle locally (Solid 2 main.jsx or a static folder); call it directly only with a ready bundle.",
    inputSchema: { type: "object", required: ["name", "manifest", "files"], properties: {
      name: s("artifact name: lowercase letters, digits, dashes"), manifest: { type: "object", description: "{ title?, tools? }" },
      files: { type: "object", additionalProperties: { type: "string" }, description: "path -> text content; must include index.html" } } },
  },
  { name: "list_artifacts", description: "List all artifacts with their URL, version and sharing mode.",
    inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { name: "get_comments", description: `Comments on an artifact that are for you: ${owner}'s own (unless ${owner} kept one from you) and the ones ${owner} forwarded. Guest comments appear only once ${owner} forwards them.`,
    inputSchema: { type: "object", required: ["name"], properties: { name: s("artifact name"), status: { type: "string", enum: ["open", "resolved", "all"], description: "default open" } } },
    annotations: { readOnlyHint: true } },
  { name: "reply_comment", description: "Reply to a comment thread (say what you changed). Viewers see it live.",
    inputSchema: { type: "object", required: ["name", "comment", "text"], properties: { name: s("artifact name"), comment: s("comment id"), text: s("reply text") } } },
  { name: "resolve_comment", description: "Mark a comment thread resolved once you have handled it.",
    inputSchema: { type: "object", required: ["name", "comment"], properties: { name: s("artifact name"), comment: s("comment id") } } },
];

type Env = { APP_ORIGIN: string; OWNER_NAME?: string; PLATFORM: any; ROOM: any };
const AGENT = { kind: "agent" };

async function call(env: Env, tool: string, a: any) {
  const platform: Platform = env.PLATFORM.getByName("main");
  const url = (name: string) => `${env.APP_ORIGIN}/v/${encodeURIComponent(name)}`;
  const comments = async (name: string) => {
    if (!(await platform.access(String(name), AGENT))) throw new UserError(404, `no artifact ${name}`);
    return env.ROOM.getByName(`comments:${name}`);
  };
  switch (tool) {
    case "publish_artifact": {
      const r = await platform.publish(a.name, a.manifest, a.files, "agent");
      return { name: a.name, version: r.version, url: url(a.name) };
    }
    case "list_artifacts":
      return ((await platform.listFor(AGENT)) as any[]).map((x) => ({ ...x, url: url(x.name) }));
    case "get_comments": {
      const st = a.status ?? "open";
      if (!["open", "resolved", "all"].includes(st)) throw new UserError(400, "status: open | resolved | all");
      const items: any[] = await (await comments(a.name)).agentView();
      return items.filter((t) => st === "all" || t.resolved === (st === "resolved"));
    }
    case "reply_comment":
      return (await comments(a.name)).postComment("agent", { type: "reply", comment: a.comment, text: a.text });
    case "resolve_comment":
      return (await comments(a.name)).postComment("agent", { type: "resolve", comment: a.comment });
  }
  throw new UserError(400, `unknown tool ${tool}`);
}

export async function mcp(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } }); // no SSE stream, no sessions
  let m: any;
  try { m = await readJson(req); } catch (e: any) { // size cap: pre-Funnel review B1
    if (e?.status === 413) throw e;
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, { status: 400 });
  }
  if (m?.id === undefined || m?.id === null) return new Response(null, { status: 202 }); // a notification
  const ok = (result: unknown) => Response.json({ jsonrpc: "2.0", id: m.id, result });
  switch (m.method) {
    case "initialize":
      return ok({ protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} },
        serverInfo: { name: "artifacts-platform", version: "1.0.0" },
        instructions: `${ownerName(env)}'s artifacts platform: publish pages, read the comments meant for you, reply and resolve.` });
    case "ping": return ok({});
    case "tools/list": return ok({ tools: tools(ownerName(env)) });
    case "tools/call":
      try {
        const r = await call(env, m.params?.name, m.params?.arguments ?? {});
        return ok({ content: [{ type: "text", text: JSON.stringify(r) }] });
      } catch (e: any) {
        // a refusal (UserError) becomes a tool error; anything else is a bug: 500, loudly. Across DO RPC (Platform, Room) celld
        // 0.6.3 delivers a plain Error that keeps `status` but not the class, hence the same two checks as index.ts.
        if (!(e instanceof UserError) && !e?.status) throw e;
        return ok({ isError: true, content: [{ type: "text", text: String(e.message) }] });
      }
  }
  return Response.json({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } });
}
