// Calls each owner query this page knows about; a query the
// current version does not declare shows the platform's refusal (so a guest on an older version sees "not available yet").
const QUERIES = [["uptime", "Uptime"], ["sw_vers", "macOS"], ["list_scratch", "Scratch folders (names)"]];
const out = document.getElementById("out");
await window.artifact.ready;
for (const [tool, label] of QUERIES) {
  const box = document.createElement("section");
  box.dataset.testid = `q-${tool}`;
  box.innerHTML = `<h2></h2><pre>loading…</pre>`;
  box.querySelector("h2").textContent = label;
  out.append(box);
  const r = await window.artifact.tools.call(tool);
  box.dataset.state = r.ok ? "ok" : r.error;
  box.querySelector("pre").textContent = r.ok ? r.result.content.map((c) => c.text).join("\n") : `not available (${r.error})`;
}
