#!/bin/bash
# based on spike-infra-v1's status.sh. Read-only. Usage: scripts/status.sh [local|prod]
source "$(dirname "$0")/stack.sh"
for n in $APP $CONTENT; do
  echo "== $n: $(docker inspect -f '{{.State.Status}} mem={{.HostConfig.Memory}} net={{.HostConfig.NetworkMode}} ports={{json .HostConfig.PortBindings}}' $n 2>&1)"
  docker inspect -f '{{.State.Running}}' $n 2>/dev/null | grep -q true || continue
  [ $MODE = prod ] && docker exec $n sh -c 'tailscale status --self=true --peers=false 2>&1 | head -2; tailscale funnel status 2>&1 | head -6'
  [ $n = $APP ] && echo "platform /api/me -> $(docker exec $n curl -s -m 3 -H "Host: $APP_HOST" localhost:8080/api/me)"
done
exit 0
