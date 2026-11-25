#!/bin/bash
# based on spike-infra-v1's up/down/status.sh. Shared by up.sh / down.sh / status.sh.
# MODE=local: one container artifacts-local-app, celld published on 127.0.0.1:8341 (tests put tests/support/tailnet-proxy.mjs
#             in front), config infra/local.env, data volume artifacts-local-app-celld. No tailnet.
# MODE=prod : artifacts-app (tailscaled + celld) and artifacts-usercontent (tailscaled only) on the private network
#             artifacts-net; config infra/prod.env; volumes artifacts-app-ts, artifacts-app-celld, artifacts-usercontent-ts.
#             No host ports: both are reachable only through their tailnet node (Funnel).
# local stack name/ports from CORE_STACK_NAME, CORE_PROXY_PORT, CORE_UPSTREAM_PORT so parallel chunks don't collide.
set -euo pipefail
cd "$(dirname "$0")/.."
MODE=${1:-local}
MEM=2g # the container limit of every stack: celld's memory grows with the artifacts opened since the last restart (residual 19; lead)
IMAGE=artifacts-platform:${CORE_STACK_NAME:-core} # own tag per stack: a parallel checkout must not rebuild the image another is starting
case $MODE in
  local) UP=${CORE_UPSTREAM_PORT:-8341}; . scripts/local-env.sh; ENV_FILE=$LOCAL_ENV; APP=${CORE_STACK_NAME:-artifacts-local-app}; CONTENT=; NET=; PUBLISH="-p 127.0.0.1:$UP:8080"; TAILSCALE=0 ;;
  prod)  ENV_FILE=infra/prod.env; APP=artifacts-app; CONTENT=artifacts-usercontent; NET=artifacts-net; PUBLISH=; TAILSCALE=1
         # chunk 3 (from scripts/tools-env.sh): The owner's MCP servers and the token key file
         MCP_CONFIG=infra/prod.mcp.json; ADD_HOSTS=
         TOKEN_KEY_FILE=$(sed -nE 's#^TOKEN_KEY_FILE=##p' infra/prod.env 2>/dev/null | tail -1); TOKEN_KEY_FILE=${TOKEN_KEY_FILE/#\~/$HOME} ;;
  *) echo "usage: $0 local|prod" >&2; exit 2 ;;
esac
[ -f $ENV_FILE ] || { echo "missing $ENV_FILE (see infra/local.env for the keys)" >&2; exit 1; }
APP_HOST=$(sed -nE 's#^APP_ORIGIN=https?://##p' $ENV_FILE)
