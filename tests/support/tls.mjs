// TEST-ONLY TLS for the local stack: a self-signed cert for app/content.localtest.me
// (public DNS -> 127.0.0.1), localhost and 127.0.0.1, made once per checkout (tests/support/.tls, gitignored). Production TLS comes from tailscale serve.
// Why TLS locally: WebKit keeps no Secure (so no __Host-) cookie on http://localhost, and DoD 4 needs a WebKit viewer.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const DIR = path.join(path.dirname(new URL(import.meta.url).pathname), ".tls");
export function tls() {
  const key = path.join(DIR, "key.pem"), cert = path.join(DIR, "cert.pem");
  if (!fs.existsSync(cert)) {
    fs.mkdirSync(DIR, { recursive: true });
    execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "3650",
      "-keyout", key, "-out", cert, "-subj", "/CN=artifacts-local-test", "-addext", "subjectAltName=DNS:app.localtest.me,DNS:content.localtest.me,DNS:localhost,IP:127.0.0.1"], { stdio: "ignore" });
  }
  const pem = fs.readFileSync(cert, "utf8");
  // Chromium's --ignore-certificate-errors-spki-list makes this cert count as valid (WebAuthn refuses pages with cert errors)
  const spki = crypto.createHash("sha256").update(new crypto.X509Certificate(pem).publicKey.export({ type: "spki", format: "der" })).digest("base64");
  return { key: fs.readFileSync(key, "utf8"), cert: pem, spki };
}
