#!/bin/bash
# Native dev loop (macOS): build, then (re)start celld on 127.0.0.1:8341 with
# infra/local.env, state in app/.celld. Needs CELLD=<path to a celld 0.6.3 binary for this machine>. Not the production path
# (scripts/up.sh runs the container). Stop: scripts/dev.sh stop. Don't run it while the local container stack holds 8341.
# local stack name/ports from CORE_STACK_NAME, CORE_PROXY_PORT, CORE_UPSTREAM_PORT so parallel chunks don't collide.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=${CORE_UPSTREAM_PORT:-8341}; PIDF=.run/celld-$PORT.pid; . scripts/local-env.sh
stop() { if [ -f $PIDF ]; then P=$(cat $PIDF); pkill -P $P 2>/dev/null || true; kill $P 2>/dev/null || true; rm -f $PIDF; fi
  for i in $(seq 1 60); do lsof -nP -tiTCP:$PORT -sTCP:LISTEN >/dev/null || return 0; sleep 1; done; echo "port $PORT still busy" >&2; return 1; }
if [ "${1:-}" = stop ]; then stop; exit; fi
: "${CELLD:?set CELLD to a celld 0.6.3 binary}"
npm run -s build
ensure_token_key
cp $LOCAL_ENV app/.dev.vars
chmod 600 app/.dev.vars # chunk 3: MCP servers + token key (from local-env.sh), like infra/entrypoint.sh
printf 'MCP_SERVERS=%s\nTOKEN_KEY=%s\n' "$(tr -d '\n' < $MCP_CONFIG)" "$(tr -d '\n' < "$TOKEN_KEY_FILE")" >> app/.dev.vars
stop
CELLD_ESBUILD=$PWD/node_modules/.bin/esbuild nohup "$CELLD" dev app --host 127.0.0.1 --port $PORT --no-watch --logs > .run/celld.log 2>&1 &
echo $! > $PIDF
HOST=$(sed -nE 's#^APP_ORIGIN=https?://##p' $LOCAL_ENV)
for i in $(seq 1 60); do curl -sf -o /dev/null -H "Host: $HOST" 127.0.0.1:$PORT/api/me && { echo "celld up on 127.0.0.1:$PORT (log .run/celld.log)"; exit 0; }; sleep 0.5; done
echo "celld did not come up; see .run/celld.log" >&2; exit 1
