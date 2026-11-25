#!/bin/bash
# based on spike-infra-v1's down.sh. Stops (does not remove) the containers;
# volumes, network and tailnet nodes are kept. Idempotent. Usage: scripts/down.sh [local|prod]
source "$(dirname "$0")/stack.sh"
for n in $APP $CONTENT; do
  if docker container inspect $n >/dev/null 2>&1; then docker stop -t 30 $n >/dev/null; echo "[$n] stopped"; else echo "[$n] not created"; fi
done
