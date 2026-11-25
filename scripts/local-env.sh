# the one place that renders a local stack's config (chunk 3's scripts/tools-env.sh and scripts/local-mcp.mjs folded in, L3).
# Sourced by stack.sh and dev.sh; tests/support/env.mjs runs it too and reads the files it writes. For CORE_PROXY_PORT (default
# 8340), with one rule (every *.localtest.me:<port> moves by CORE_PROXY_PORT - 8340):
#   LOCAL_ENV       .run/local-<port>.env       from infra/local.env (the two origins)
#   MCP_CONFIG      .run/local-<port>.mcp.json  from infra/local.mcp.json (the owner's MCP servers; the egress allowlist derives from it)
#   ADD_HOSTS       --add-host <name>:host-gateway for those *.localtest.me names (inside a container they must mean the Mac,
#                   where npm test runs the fixture servers)
#   TOKEN_KEY_FILE  path of the AES key for stored OAuth tokens: CORE_TOKEN_KEY_FILE or .run/<stack>-token-key (up.sh and
#                   dev.sh call ensure_token_key, which creates it 0600 if missing; prod: TOKEN_KEY_FILE in infra/prod.env, see stack.sh). Sourcing renders only; the key comes from ensure_token_key.
# Ports per stack: proxy +0, celld +1, tailnet door +2, loop relay +3, canary +4, studio +5, items +6, rogue +7 (off-list origin +8).
PX=${CORE_PROXY_PORT:-8340}; mkdir -p .run
render() { perl -pe "s/(\.localtest\.me:)(\d+)/\$1.(\$2 - 8340 + $PX)/ge" "$1"; }
LOCAL_ENV=.run/local-$PX.env; render infra/local.env > $LOCAL_ENV
MCP_CONFIG=.run/local-$PX.mcp.json; render infra/local.mcp.json > $MCP_CONFIG
ADD_HOSTS=$(grep -oE '[a-z0-9-]+\.localtest\.me' $MCP_CONFIG | sort -u | sed 's/.*/--add-host &:host-gateway/' | tr '\n' ' ')
TOKEN_KEY_FILE=${CORE_TOKEN_KEY_FILE:-$PWD/.run/${CORE_STACK_NAME:-artifacts-local-app}-token-key}
ensure_token_key() { [ -f "$TOKEN_KEY_FILE" ] || { (umask 077; openssl rand -base64 32 > "$TOKEN_KEY_FILE"); echo "created token key $TOKEN_KEY_FILE"; }; }
