// The companies in the viewer's own Attio workspace, via Attio's
// MCP server (read-only tool list-records) with the viewer's own connection. No Attio-specific platform code: only this page knows
// Attio. Shows whose account and workspace answered (whoami), then list-records' text answer as is.
const status = document.querySelector('[data-testid="status"]'), raw = document.querySelector('[data-testid="raw"]');
const MSG = { declined: "No live data: you chose not to share your account with this page.", not_connected: "Connect Attio (link above the page) to see your companies." };
await window.artifact.ready;
status.textContent = "Loading your companies…";
const who = await window.artifact.tools.call("whoami");
if (who.ok) document.querySelector('[data-testid="whoami"]').textContent = who.result.content.map((c) => c.text).join("\n").split("\n").filter((l) => /^(email|workspace_slug|workspace_name):/.test(l)).join(" · ");
const r = await window.artifact.tools.call("list-records", { object: "companies", limit: 50 });
status.dataset.state = r.ok ? "ok" : r.error;
if (!r.ok) status.textContent = MSG[r.error] ?? `Could not load (${r.error}: ${r.message ?? ""}).`;
else { status.textContent = "The companies in your Attio workspace:"; raw.textContent = r.result.content.map((c) => c.text).join("\n"); }
