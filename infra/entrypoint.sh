#!/bin/sh
# copied from the spike-infra-v1 entrypoint and changed:
# ROLE=app     : (tailscaled if TAILSCALE=1) + celld on 0.0.0.0:8080 (reachable by artifacts-usercontent on the private
#                docker network; the host sees it only if up.sh publishes a port, which only local mode does)
# ROLE=content : tailscaled only; its serve/funnel proxies to http://artifacts-app:8080 (one platform Worker, one data volume)
# Config (APP_ORIGIN, CONTENT_ORIGIN, OWNER_LOGINS, AGENT_TOKEN) comes from the container env and is written to /app/.dev.vars for celld.
# Chunk 3: MCP_SERVERS from the mounted config /run/config/mcp.json, TOKEN_KEY from the mounted
# secret file /run/secrets/token-key. /app/.dev.vars is in the container layer, not in the data volume (/app/.celld).
set -e
TS="tailscaled --tun=userspace-networking --state=/var/lib/tailscale/tailscaled.state --socket=/var/run/tailscale/tailscaled.sock"
mkdir -p /var/run/tailscale
if [ "$ROLE" = content ]; then exec $TS; fi
[ "$ROLE" = app ] || { echo "ROLE must be app or content" >&2; exit 1; }
: "${APP_ORIGIN:?}" "${CONTENT_ORIGIN:?}" "${OWNER_LOGINS:?}" "${AGENT_TOKEN:?}"
umask 077
[ -s /run/config/mcp.json ] && [ -s /run/secrets/token-key ] || { echo "mount /run/config/mcp.json and /run/secrets/token-key (scripts/up.sh does)" >&2; exit 1; }
# OWNER_NAME (optional, the owner's display name; the worker defaults to "Owner")
printf 'APP_ORIGIN=%s\nCONTENT_ORIGIN=%s\nOWNER_LOGINS=%s\nOWNER_NAME=%s\nAGENT_TOKEN=%s\nMCP_SERVERS=%s\nTOKEN_KEY=%s\n' "$APP_ORIGIN" "$CONTENT_ORIGIN" "$OWNER_LOGINS" "${OWNER_NAME:-}" "$AGENT_TOKEN" \
  "$(tr -d '\n' < /run/config/mcp.json)" "$(tr -d '\n' < /run/secrets/token-key)" > /app/.dev.vars
if [ "${TAILSCALE:-0}" = 1 ]; then $TS & fi
exec celld dev /app --host 0.0.0.0 --port 8080 --no-watch --logs
