// Shows the viewer's own items; without consent or a connection
// it says so and shows no data. The page never sees a token: the shell calls the tool with the viewer's connection.
const status = document.querySelector('[data-testid="status"]'), list = document.querySelector('[data-testid="items"]');
const MSG = { declined: "No live data: you chose not to share your account with this page.", not_connected: "Connect your account (link above the page) to see your items.", consent_required: "Waiting for your permission." };
await window.artifact.ready;
status.textContent = `Hello ${window.artifact.viewer.name ?? "there"}, loading your items…`;
const r = await window.artifact.tools.call("list_my_items");
if (!r.ok) { status.textContent = MSG[r.error] ?? `Could not load your items (${r.error}).`; status.dataset.state = r.error; }
else {
  const items = JSON.parse(r.result.content[0].text);
  status.textContent = `${items.length} item(s) in your account:`; status.dataset.state = "ok";
  for (const it of items) { const li = document.createElement("li"); li.textContent = it.name; li.dataset.testid = "item"; list.append(li); }
}
