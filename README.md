# Salon

A self-hosted replacement for Claude artifacts: pages your agents publish, opened on any device, shared privately, with named
guests (passkeys) or by link, with live shared state. One platform Worker on celld 0.6.3 in Docker, reached through two
Tailscale Funnel hostnames (app host + content host). How it works and what it protects against: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md);
the decisions behind it, with the alternatives: [docs/DECISIONS.md](docs/DECISIONS.md).
"The owner" is the one person who runs the platform and publishes through pi; their display name comes from `OWNER_NAME` (default "Owner").

## Run it
```sh
npm install
scripts/up.sh local      # one container, platform on 127.0.0.1:8341 (plain http; the test proxy adds TLS on :8340), config infra/local.env
scripts/status.sh local
npm test                 # builds, then the Playwright suite (Chrome) against the local stack; restarts it once at the end
scripts/down.sh local    # stops; data stays in the volume
```
Tools: `scripts/local-env.sh` renders each local stack's config, its MCP servers included
(`infra/local.mcp.json` moved to the stack's ports; prod: `infra/prod.mcp.json`). The AES key for stored OAuth tokens: local
`CORE_TOKEN_KEY_FILE` or `.run/<stack>-token-key`, created 0600 by `up.sh`/`dev.sh`; prod `TOKEN_KEY_FILE` in `infra/prod.env`. `npm test` starts the test MCP servers itself (`tests/fixtures/mcp-studio`,
`tests/fixtures/mcp-oauth`).
Production: copy `infra/prod.env.example` to `infra/prod.env` and fill in the real hostnames, owner login and secrets, then
`scripts/up.sh prod`: it is meant to print a Tailscale login URL per node until both are joined, then enable Funnel.

Developing without Docker: `CELLD=<celld 0.6.3 binary for this machine> scripts/dev.sh` (native celld on the same port).
Negative controls (re-prove that each security guard is what makes its test pass): `CELLD=… tests/negative-controls.sh`.

## Publish from pi (authoring loop)
pi publishes and maintains pages through the platform's MCP endpoint plus a small pi extension (chunk 4; design in
[docs/ARCHITECTURE.md → Comments and pi](docs/ARCHITECTURE.md#comments-and-pi-chunk-4)). On the machine pi runs on (a
tailnet device), with this repo checked out and `npm install`ed:
1. Environment for pi: `ARTIFACTS_ORIGIN=https://<app host>` and `ARTIFACTS_AGENT_TOKEN=<AGENT_TOKEN from infra/prod.env>`.
2. `~/.pi/agent/mcp.json` (or a project's `.pi/mcp.json`):
   ```json
   { "mcpServers": { "artifacts": { "url": "https://<app host>/api/mcp",
     "headers": { "Authorization": "Bearer ${ARTIFACTS_AGENT_TOKEN}" },
     "exposure": "direct", "toolExposure": { "publish_artifact": "hidden" } } } }
   ```
   Check it with `pi mcp list` (5 tools; `publish_artifact` hidden: the extension's version builds locally).
3. Load the extension: `"extensions": ["<repo>/integrations/pi/artifact-bridge.ts"]` in pi's `settings.json`.

pi then has `publish_artifact {name, dir}` (builds `<dir>`: `manifest.json` + Solid 2 `main.jsx` [+ `style.css`], or a static
folder with `index.html`) and the MCP tools `list_artifacts`, `get_comments`, `reply_comment`, `resolve_comment`. A session
that published an artifact, or took it over with `follow_artifact {name}` (no republish), receives the owner's comments on it (unless he unticks "Send to agent"; those and guest comments reach pi once he presses the shell's
"Forward to pi" button) as follow-up messages, also those made while pi was offline. Without pi: POST `bundleArtifact(dir)`'s
output to `/api/artifacts/<name>/versions` from the tailnet with the bearer token, or as the owner's signed-in browser.

Several local stacks side by side: `CORE_STACK_NAME=<container> CORE_PROXY_PORT=<port> CORE_UPSTREAM_PORT=<port+1>` for
`scripts/*.sh` and `npm test` (the test proxy also opens a test-only tailnet door on proxy port + 2 for pi and its bridge).
Artifacts talk to the platform only through `/_sdk/artifact-sdk.js` (room, tools, viewer); see the header of
`src/sdk/artifact-sdk.js` and the ported example `artifacts/shared-list/`. Show inputs only when `artifact.viewer.canWrite`
(link visitors view only, unless the owner turns on "link visitors may write to the room" for the page; then each browser writes as
one `v:…` id, so one vote per phone is best effort).

## Tools (live data from MCP servers)
The owner's MCP servers are configured in `infra/<stack>.mcp.json` (`MCP_CONFIG` in the env file; production: `infra/prod.mcp.json`);
the platform contacts nothing else. A manifest declares tools by name and server:
`{"name": "uptime", "server": "studio", "binding": "owner", "args": {}}` (the owner's account, pinned arguments) or
`{"name": "list_my_items", "server": "items", "binding": "viewer"}` (each viewer's own account, after their consent). Read-only
tools only (the server must mark them `readOnlyHint`). Versions with viewer tools or new owner queries wait for the owner's Approve
button before guests see them, and a version with viewer tools gets a read-only room (personal data stays personal). Examples: `artifacts/studio-status/` (use case A), `artifacts/my-items/` (B),
`artifacts/attio-companies/` (B on Attio). Details: [docs/ARCHITECTURE.md → Tools](docs/ARCHITECTURE.md#tools-chunk-3).

## Known limitations
A pi session receives comments on the pages it published or followed (`follow_artifact {name}`, no republish needed; comments nobody has received yet are replayed). Every session that follows a page receives its comments; following does not make the others stop, and there is no unfollow yet.

## License
MIT, see [LICENSE](LICENSE).
