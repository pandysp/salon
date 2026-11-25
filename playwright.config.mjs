// npm test = build + this suite against the running local stack
// (scripts/up.sh, or a native celld on 127.0.0.1:8341). The test proxy on :8340 stands in for tailscale (tests/support).
import { defineConfig } from "@playwright/test";
import { tls } from "./tests/support/tls.mjs";
export default defineConfig({
  testDir: "tests",
  timeout: 90_000,
  workers: 1,
  reporter: "list",
  globalSetup: "./tests/support/global-setup.mjs",
  use: { browserName: "chromium", channel: "chrome", viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true,
    launchOptions: { args: [`--ignore-certificate-errors-spki-list=${tls().spki}`] } },
  projects: [
    { name: "core", testMatch: /(identity|isolation|room|versions|loop|review|tools|pins)\.spec\.mjs/ }, // tools: chunk 3
    { name: "ops", testMatch: /ops\.spec\.mjs/, dependencies: ["core"] }, // restarts the stack: runs last
  ],
});
