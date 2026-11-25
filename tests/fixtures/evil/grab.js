// Runs before the SDK: keeps a copy of every port the shell hands over, so the
// attacks below use the raw shell protocol, not only the SDK's polite API.
window.__ports = [];
addEventListener("message", (e) => { if (e.ports[0]) window.__ports.push(e.ports[0]); });
