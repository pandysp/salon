// TEST-ONLY stand-in for tailscale serve/Funnel in front of celld. Never part of the production path (production: the
// containers' tailscaled, see infra/). It copies what tailscale v1.104.7 ipn/ipnlocal/serve.go does:
//  - terminates TLS (test cert, tests/support/tls.mjs), then proxies plain http to celld, like tailscale serve
//  - keeps Host, sets X-Forwarded-Host / -Proto / -For (addProxyForwardedHeaders)
//  - deletes every client-sent Tailscale-User-* / Tailscale-Funnel-Request / Tailscale-Headers-Info (addTailscaleIdentityHeaders)
//  - "tailnet" client (the test's owner browser, recognised by a per-run secret header that is removed here) ->
//    Tailscale-User-Login: <owner login>; every other client is treated as Funnel traffic -> Tailscale-Funnel-Request: ?1
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tls } from "./tls.mjs";

const IDENTITY = ["tailscale-user-login", "tailscale-user-name", "tailscale-user-profile-pic", "tailscale-funnel-request", "tailscale-headers-info"];
export const MARKER = "x-test-tailnet";

//  - optional tailnetPort: a second listener where every client counts as a tailnet
//    device and Host is rewritten to the main port, so a pi session or bridge (which cannot send the per-run marker) reaches
//    the app host as it would from the tailnet. Tests only, like everything here.
export function startTailnetProxy({ port, upstreamPort, ownerLogin, secret, tailnetPort, log = () => {} }) {
  const rewrite = (req) => {
    const h = { ...req.headers };
    for (const k of IDENTITY) delete h[k];
    const viaTailnetPort = tailnetPort && req.socket.localPort === tailnetPort;
    const tailnet = viaTailnetPort || h[MARKER] === secret;
    delete h[MARKER];
    if (viaTailnetPort) h.host = String(h.host).replace(/:\d+$/, `:${port}`);
    h["x-forwarded-host"] = h.host;
    h["x-forwarded-proto"] = "https";
    h["x-forwarded-for"] = req.socket.remoteAddress;
    if (tailnet) { h["tailscale-user-login"] = ownerLogin; h["tailscale-user-name"] = "Owner (test)"; }
    else h["tailscale-funnel-request"] = "?1";
    log(`${tailnet ? "tailnet" : "funnel "} ${req.method} ${req.headers.host}${req.url}`);
    return h;
  };
  const { key, cert } = tls();
  const server = https.createServer({ key, cert }, (req, res) => {
    const up = http.request({ host: "127.0.0.1", port: upstreamPort, method: req.method, path: req.url, headers: rewrite(req) }, (r) => {
      res.writeHead(r.statusCode, r.rawHeaders);
      r.pipe(res);
    });
    // the upstream may answer early (413) and then cut the upload: the answer is already on its way, so only close (B1)
    up.on("error", (e) => { if (res.headersSent) return res.destroy(); res.writeHead(502); res.end("proxy: upstream error " + e.message); });
    req.pipe(up);
  });
  server.on("upgrade", (req, sock, head) => {
    const h = rewrite(req);
    const up = net.connect(upstreamPort, "127.0.0.1", () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (const [k, v] of Object.entries(h)) for (const x of [].concat(v)) lines.push(`${k}: ${x}`);
      up.write(lines.join("\r\n") + "\r\n\r\n");
      if (head?.length) up.write(head);
      up.pipe(sock); sock.pipe(up);
    });
    const end = () => { up.destroy(); sock.destroy(); };
    up.on("error", end); sock.on("error", end);
  });
  // the tailnet port hands its sockets to the same server, so both ports share handlers and close()/closeAllConnections()
  const tailnetDoor = tailnetPort && net.createServer((sock) => server.emit("connection", sock));
  if (tailnetDoor) server.on("close", () => tailnetDoor.close());
  const listen = (srv, p) => new Promise((resolve) => srv.listen(p, "127.0.0.1", resolve));
  return Promise.all([listen(server, port), tailnetDoor && listen(tailnetDoor, tailnetPort)]).then(() => server);
}
