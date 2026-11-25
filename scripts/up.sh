#!/bin/bash
# based on spike-infra-v1's up.sh. Idempotent: builds the Worker and the image,
# creates network/volumes if missing, re-creates the containers (graceful stop first; volumes keep all data, so a rebuilt image
# or changed config always takes effect) and waits until the platform answers. prod: prints a login URL for a node that is not joined yet, else (re)applies Funnel.
# Usage: scripts/up.sh [local|prod]
source "$(dirname "$0")/stack.sh"
# the token key (chunk 3): local stacks make their own; prod's comes from 1Password (infra/prod.env TOKEN_KEY_FILE)
if [ $MODE = local ]; then ensure_token_key
else [ -n "$TOKEN_KEY_FILE" ] && [ -s "$TOKEN_KEY_FILE" ] || { echo "infra/prod.env: TOKEN_KEY_FILE must name an existing key file (from 1Password)" >&2; exit 1; }; fi
npm run -s build >/dev/null
docker build -q -f infra/Dockerfile -t $IMAGE . >/dev/null
[ -n "$NET" ] && { docker network inspect $NET >/dev/null 2>&1 || docker network create $NET >/dev/null; }
ensure() { # name role [-v volume:path ...]   (docker creates missing named volumes)
  local name=$1 role=$2; shift 2
  if docker container inspect $name >/dev/null 2>&1; then docker stop -t 30 $name >/dev/null; docker rm $name >/dev/null; fi
  # --restart: a crash (e.g. celld out of memory) heals itself instead of leaving both hostnames down (pre-Funnel review B1)
  docker create --name $name --hostname $name --restart unless-stopped --memory $MEM --memory-swap $MEM \
      ${NET:+--network $NET} $( [ $role = app ] && echo "$PUBLISH --env-file $ENV_FILE $ADD_HOSTS -v $PWD/$MCP_CONFIG:/run/config/mcp.json:ro -v $TOKEN_KEY_FILE:/run/secrets/token-key:ro" ) -e ROLE=$role -e TAILSCALE=$TAILSCALE \
      "$@" $IMAGE >/dev/null
  docker start $name >/dev/null
}
if [ $MODE = local ]; then ensure $APP app -v $APP-celld:/app/.celld
else ensure $APP app -v $APP-ts:/var/lib/tailscale -v $APP-celld:/app/.celld; ensure $CONTENT content -v $CONTENT-ts:/var/lib/tailscale; fi
for i in $(seq 1 90); do docker exec $APP curl -sf -o /dev/null -H "Host: $APP_HOST" localhost:8080/api/me && break; sleep 1; done
docker exec $APP curl -sf -o /dev/null -H "Host: $APP_HOST" localhost:8080/api/me || { echo "[$APP] platform did not answer; docker logs $APP" >&2; exit 1; }
echo "[$APP] platform up ($MODE)"
[ $MODE = prod ] || exit 0
for pair in "$APP:8080" "$CONTENT:http://$APP:8080"; do
  n=${pair%%:*} target=${pair#*:}
  for i in $(seq 1 30); do docker exec $n tailscale status --json >/dev/null 2>&1 && break; sleep 1; done
  state=$(docker exec $n tailscale status --json | sed -n 's/.*"BackendState": "\(.*\)".*/\1/p' | head -1)
  if [ "$state" != Running ]; then
    echo "[$n] state=$state: needs login"; docker exec $n tailscale up --hostname=$n --timeout=1s 2>&1 | grep -i 'https://' || true
    echo "[$n] approve the URL above, then re-run up.sh prod"; continue
  fi
  docker exec $n tailscale funnel --bg "$target" >/dev/null
  echo "[$n] joined: $(docker exec $n tailscale status --json | sed -n 's/.*"DNSName": "\(.*\)",/\1/p' | head -1) funnel -> $target"
done
