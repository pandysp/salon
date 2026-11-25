#!/bin/bash
# Negative controls: for each security guard, patch it out of the
# source, rebuild, run only the test that guards it and require that test to FAIL; save its output to
# .run/evidence/negative-controls/<name>.txt; restore the source. Ends with a clean rebuild. Native celld only (scripts/dev.sh).
# Usage: CELLD=<celld binary> tests/negative-controls.sh [name ...]   (no names = all)
set -uo pipefail
cd "$(dirname "$0")/.."
OUT=${CORE_EVIDENCE_DIR:-.run/evidence}/negative-controls; mkdir -p $OUT
git diff --quiet -- src || { echo "src/ has uncommitted changes; commit first (this script restores src/ with git checkout)" >&2; exit 1; }
FAILS=0
ONLY=" $* "
nc() { # name file perl-substitution test-file test-grep
  local name=$1 file=$2 sub=$3 spec=$4 grep=$5
  [ "$ONLY" != "  " ] && [[ "$ONLY" != *" $name "* ]] && return
  perl -0pi -e "\$n = ($sub); END { exit(\$n ? 0 : 3) }" "$file" || { echo "[$name] PATCH DID NOT APPLY" | tee $OUT/$name.txt; FAILS=1; git checkout -q -- src; return; }
  scripts/dev.sh >/dev/null || { echo "[$name] build/start failed"; FAILS=1; git checkout -q -- src; return; }
  { echo "# negative control '$name': $file patched with: $sub"; echo "# expected: $spec -g \"$grep\" FAILS"; git diff -U0 -- src | sed 's/^/# /'; } > $OUT/$name.txt
  npx playwright test "$spec" --project core -g "$grep" >> $OUT/$name.txt 2>&1; local rc=$?
  echo "exit $rc" >> $OUT/$name.txt
  if [ $rc -ne 0 ] && grep -q '✘' $OUT/$name.txt && grep -qE '^\s+1 failed' $OUT/$name.txt; then
    echo "[$name] fails without the guard (as required): $(grep -v '^\s*at ' $OUT/$name.txt | grep -m1 -A3 -E '^\s+Error:' | tr -s ' \n' ' ' | cut -c1-220)"
  else echo "[$name] NOT a clean failure (rc=$rc) -> the test does not prove this guard"; FAILS=1; fi
  git checkout -q -- src
}
nc content-csp   src/worker/index.ts   's/"content-security-policy": CONTENT_CSP\(env\) //' tests/isolation.spec.mjs "DoD 3"
nc shell-frame-src src/worker/index.ts 's/frame-src \$\{env.CONTENT_ORIGIN\};/frame-src *;/' tests/isolation.spec.mjs "DoD 3"
nc origin-check  src/worker/index.ts   's/const bad = foreignOrigin\(req, env\);/const bad = null;/' tests/identity.spec.mjs "CSRF"
nc funnel-marker src/worker/index.ts   's/return !!login && !req\.headers\.has\("tailscale-funnel-request"\) && /return !!login \&\& /' tests/identity.spec.mjs "forged"
nc header-is-identity src/worker/index.ts 's/(async function identify\(req: Request, env: Env\): Promise<Viewer> \{\n)/$1  if (tailnetOwner(req, env)) return { kind: "owner", id: "owner", name: ownerName(env) };\n/' tests/identity.spec.mjs "header alone"
nc agent-only-tailnet src/worker/index.ts 's/    if \(funnel\) throw new UserError\(403, "the agent token works only from the tailnet"\);\n//' tests/identity.spec.mjs "bearer token acts"
# review fixes: each control undoes one fix; its tests/review.spec.mjs test must fail
nc owner-not-on-funnel src/worker/index.ts 's/return funnel \? PUBLIC : \{ kind: "owner"/return { kind: "owner"/' tests/review.spec.mjs "F2:"
nc link-rotation src/worker/platform.ts 's/const link = rand\(24\);/const link = this.#one("SELECT link_token AS t FROM artifacts WHERE name = ?", name).t ?? rand(24);/' tests/review.spec.mjs "F3:"  # the old "stable once made"
nc no-token-in-details src/worker/platform.ts 's/      name: a\.name, sharing: a\.sharing, current_version: a\.current_version, created_at: a\.created_at,/      ...a,/' tests/review.spec.mjs "F3:"
nc link-owner-only src/worker/index.ts 's/return json\(viewer\.kind === "owner" \? \{ \.\.\.d, link:/return json(true ? { ...d, link:/' tests/review.spec.mjs "R2 owner link read"
nc cap-bound-to-token src/worker/platform.ts 's/\{ return a\.link_token \?\? ""; \}/{ return ""; }/' tests/review.spec.mjs "F3:"
nc room-cap src/worker/room.js 's/if \(this\.#size\(\) \+ utf8\(body\) \+ utf8\(from\) \+ 64 > MAX_ROOM_BYTES\)/if (false)/' tests/review.spec.mjs "F4:"
nc room-cap-rollback src/worker/room.js 's/if \(after > MAX_ROOM_BYTES\) throw/if (false) throw/' tests/review.spec.mjs "F4 rollback"
nc challenge-cap src/worker/platform.ts 's/    if \(this\.#challenges\.size >= MAX_CHALLENGES\) this\.#challenges\.delete\(this\.#challenges\.keys\(\)\.next\(\)\.value!\);\n//' tests/review.spec.mjs "F4b eviction"  # the Map's eviction (S1 moved it out of SQLite)
# S1: an anonymous call must not write to disk; the control puts one SQLite write back into every new ceremony
nc challenges-in-memory src/worker/platform.ts 's/(this\.#challenges\.set\(flow, .*?\);\n)/$1    this.#sql("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)", "last-flow", flow);\n/' tests/review.spec.mjs "S1 flood"
# P2: without the cap a configured server's answer is read whole again (500 MB had Docker kill the container)
nc response-cap src/worker/tools.ts 's/if \(n > MAX_RESPONSE_BYTES\) ctl\.error/if (false) ctl.error/' tests/tools.spec.mjs "P2 response cap"
# M1: without the deadline a hanging server holds the request (and its connection's queue) until the test times out
nc request-timeout src/worker/tools.ts 's/, AbortSignal\.timeout\(REQUEST_TIMEOUT_MS\)//' tests/tools.spec.mjs "M1 request timeout"
nc return-same-origin src/shell/main.jsx 's/const u = URL\.parse\(.*?\);\n\s*location\.href = u\?\.origin === location\.origin \? u\.href : "\/";/const b = new URLSearchParams(location.search).get("return"); location.href = b && b.startsWith("\/") && !b.startsWith("\/\/") ? b : "\/";/s' tests/review.spec.mjs "F6:"  # back to the prefix check
nc document-dest-svg src/worker/index.ts 's/, "image\/svg\+xml": "image" \}/ }/' tests/review.spec.mjs "F8 SVG"  # HTML only, as the review proposed: the SVG bypass
nc document-dest-html src/worker/index.ts 's/\{ "text\/html": "iframe", /{ /' tests/review.spec.mjs "F8:"
# invite race: celld 0.6.3 runs these requests one at a time, so the race is simulated by also undoing #invite()'s used_by check
nc invite-claim src/worker/platform.ts 's/if \(i\.used_by\) throw/if (false) throw/ && s/    if \(!this\.#sql\("UPDATE invites (.*?) RETURNING token_hash", (.*?)\)\.length\)\n      throw new UserError\(410, "This invite link has already been used\."\);\n/    this.#sql("UPDATE invites $1", $2);\n/s' tests/review.spec.mjs "invite race"
nc cookie-strict src/worker/index.ts 's/\(\?:\^\|; \?\)/(?:^|;\\\\s*)/' tests/review.spec.mjs "cookieOf"  # back to the loose \s*
# link visitors view only (R10): the read-only socket, the dropped client header, the tool gate
nc view-only-socket src/worker/room.js 's/    if \(ws\.deserializeAttachment\(\)\.from === null\) \{ ws\.close\(4003, "view only"\); return; \}\n//' tests/review.spec.mjs "R10 link view only"
nc room-from-header src/worker/index.ts 's/    headers\.delete\("x-room-from"\);\n//' tests/review.spec.mjs "R10 link view only"
nc view-only-tools src/worker/index.ts 's/    if \(!acc\.write\) return json\(\{ ok: false, error: "view_only"/    if (false) return json({ ok: false, error: "view_only"/' tests/review.spec.mjs "R10 link view only"
nc write-needs-grant src/worker/platform.ts 's/const write = owner \|\| \(granted && a\.sharing !== "private"\);/const write = viewer.kind !== "public";/' tests/review.spec.mjs "R10 link view only"  # read-only by kind: a guest without a grant would write
nc from-stamp    src/worker/room.js    's/const stored = \{ \.\.\.msg, seq, ts, from \};/const stored = { seq, ts, from, ...msg };/' tests/room.spec.mjs "server-stamped"  # line moved into #append
nc reserved-types src/worker/room.js   's/if \(typeof msg\.type === "string" && msg\.type\.startsWith\("\$"\)\) throw/if (false) throw/' tests/room.spec.mjs "reserved"
nc manifest-check src/worker/index.ts  's/if \(!tool\) \{/if (false) {/' tests/isolation.spec.mjs "DoD 3"
nc tool-name-encoding src/shell/main.jsx 's/\/\$\{encodeURIComponent\(m\.tool\)\}/\/\$\{m.tool\}/' tests/isolation.spec.mjs "DoD 3"
nc sandbox-popups src/shell/main.jsx 's/"allow-scripts allow-same-origin"\)/"allow-scripts allow-same-origin allow-popups")/' tests/isolation.spec.mjs "DoD 3"
nc sandbox-top-navigation src/shell/main.jsx 's/"allow-scripts allow-same-origin"\)/"allow-scripts allow-same-origin allow-top-navigation")/' tests/isolation.spec.mjs "DoD 3"
# the comments guard is an absence (the shell has no path from the artifact port to the comments room): the control adds one
nc comments-path src/shell/main.jsx 's/(  const handle = async \(m\) => \{\n)/$1    if (m?.kind === "comments.send") return comments_room.send(m.msg);\n/' tests/isolation.spec.mjs "DoD 3"
nc owner-args-pinned src/worker/index.ts 's/if \(tool\.binding === "owner" && Object\.keys\(args \?\? \{\}\)\.length > 0\)/if (false)/' tests/isolation.spec.mjs "DoD 3"
nc rate-cap src/worker/room.js 's/else if \(\+\+r\.n > RATE_MAX\)/else if (++r.n > Infinity)/' tests/room.spec.mjs "rate"
# pre-Funnel review: without the cap a 200 MB body is buffered again (celld ran out of heap)
nc body-cap src/worker/body.ts 's/export const MAX_BODY_BYTES = 8 \* 1024 \* 1024;/export const MAX_BODY_BYTES = Infinity;/' tests/review.spec.mjs "B1 body cap"
nc size-cap src/worker/room.js 's/if \(message\.length > MAX_MESSAGE_BYTES\) throw/if (false) throw/' tests/room.spec.mjs "message size"
nc link-token src/worker/platform.ts 's/const linkOk = a\.sharing === "link" && !!a\.link_token && k === a\.link_token;/const linkOk = a.sharing === "link";/' tests/identity.spec.mjs "sharing:"
# (readContent also accepts the version guests see; the guard is the whole if)
nc current-version-cap src/worker/platform.ts 's/    if \(a\.current_version !== Number\(version\) && this\.#approvedVersion\(artifact\) !== Number\(version\)\) return null;[^\n]*\n//' tests/identity.spec.mjs "sharing:"
nc canonical-cap src/worker/platform.ts 's/    try \{ if \(b64u\(fromB64u\(sig\)\) !== sig\) return null; \} catch \{ return null; \}\n//' tests/identity.spec.mjs "sharing:"
nc invite-single-use src/worker/platform.ts 's/if \(i\.used_by\) throw/if (false) throw/' tests/identity.spec.mjs "guest registers"
# authoring loop: the comments gate and rules, and the MCP endpoint's identity
nc gate-filter src/worker/comments.js 's/\.filter\(\(t\) => t\.from === "owner" \|\| t\.forwarded\)/.filter(() => true)/' tests/loop.spec.mjs "DoD 7"
nc gate-for-pi src/worker/comments.js 's/\(t\.from === "owner" && t\.forPi\)/t.from === "owner"/' tests/pins.spec.mjs "pin agent toggle"  # the owner's "Send to agent" box
nc gate-socket src/worker/room.js 's/kind === "comments" && from === "agent" \? agentItems\(all\) : all/all/' tests/loop.spec.mjs "DoD 7"
nc gate-on-append src/worker/room.js 's/peer\.deserializeAttachment\(\)\?\.from === "agent" \? agentFrame : JSON\.stringify\(stored\)/JSON.stringify(stored)/' tests/loop.spec.mjs "DoD 7"
nc comment-rules src/worker/room.js 's/if \(kind === "comments"\) msg = checkComment/if (false) msg = checkComment/' tests/loop.spec.mjs "DoD 7"
nc forward-owner-only src/worker/comments.js 's/      if \(by !== "owner"\) refuse\("only the owner forwards comments to pi"\);\n//' tests/loop.spec.mjs "DoD 7"
nc pi-sees-only-its-threads src/worker/comments.js 's/      if \(!t\) refuse\(`no comment \$\{msg\.comment\} visible to pi`\);\n//' tests/loop.spec.mjs "DoD 7"
nc mcp-agent-only src/worker/index.ts 's/need\("agent"\); return mcp/need("agent", "owner"); return mcp/' tests/loop.spec.mjs "DoD 7"
# chunk 3 (tools)
nc read-only-hint src/worker/tools.ts 's/if \(listed\.annotations\?\.readOnlyHint !== true\) return/if (false) return/' tests/tools.spec.mjs "use case A"
nc approval-served-version src/worker/platform.ts 's/const version = owner \? a\.current_version as number : this\.#approvedVersion\(name\);/const version = a.current_version as number;/' tests/tools.spec.mjs "use case A"
nc consent-server-side src/worker/index.ts 's/if \(tool\.binding === "viewer" && !\(await platform\.hasConsent\(/if (false \&\& !(await platform.hasConsent(/' tests/tools.spec.mjs "use case B"
nc callback-subject src/worker/platform.ts 's/    if \(row\.subject !== subject\) throw new UserError\(403, "this connection was started by someone else"\);\n//' tests/tools.spec.mjs "use case B"
nc token-encryption src/worker/platform.ts 's/await unseal\(this\.env, row\.data, aad\)/JSON.parse(new TextDecoder().decode(row.data))/ && s/await seal\(this\.env, st, aad\)/new TextEncoder().encode(JSON.stringify(st))/' tests/tools.spec.mjs "use case B"
nc egress-allowlist src/worker/tools.ts 's/if \(!server\.origins\.includes\(url\.origin\)\) \{/if (false) {/' tests/tools.spec.mjs "egress"
# integration: the tool rule (invited guests keep tools on a link page) and DoD 6 (personal or shared)
nc tools-keep-on-link src/worker/platform.ts 's/const write = owner \|\| \(granted && a\.sharing !== "private"\);/const write = owner || (granted \&\& a.sharing === "invited");/' tests/tools.spec.mjs "use case A"  # the old invited-only viewerTools rule
nc personal-no-room-writes src/worker/index.ts 's/acc\.roomWrite && !personal\(acc\.manifest\) : acc\.write;/acc.roomWrite : acc.write;/' tests/tools.spec.mjs "personal or shared"
nc version-closes-sockets src/worker/room.js 's/  versionChanged\(\) \{ for \(const ws of this\.ctx\.getWebSockets\(\)\) ws\.close\(4012, "version changed"\); \}/  versionChanged() {}/' tests/tools.spec.mjs "personal or shared"
# R11 "link visitors may write to the room": one per new guard
nc link-write-owner-only src/worker/index.ts 's/    need\("owner"\);\n(    \/\/ the approval gate)/$1/' tests/review.spec.mjs "R11 switch"  # the agent could flip it
nc link-write-needs-link src/worker/platform.ts 's/    if \(on && a\.sharing !== "link"\) throw[^\n]*\n//' tests/review.spec.mjs "R11 switch"
nc link-write-reset src/worker/platform.ts 's/const linkWrite = mode === "link" && a\.link_write === 1;/const linkWrite = a.link_write === 1;/' tests/review.spec.mjs "R11 switch"
nc link-write-gate src/worker/platform.ts 's/roomWrite: write \|\| \(linkOk && a\.link_write === 1\),/roomWrite: write || linkOk,/' tests/review.spec.mjs "R11 link visitors write"
nc link-write-off-closes src/worker/platform.ts 's/(this\.event\("link-write"[^\n]*\n)    await this\.env\.ROOM\.getByName\("app:" \+ name\)\.versionChanged\(\);\n/$1/' tests/review.spec.mjs "R11 link visitors write"
nc sharing-closes-sockets src/worker/platform.ts 's/(write right \(R11[^\n]*\n)    await this\.env\.ROOM\.getByName\("app:" \+ name\)\.versionChanged\(\);\n/$1/' tests/review.spec.mjs "R11 link visitors write"
nc visitor-from-hash src/worker/index.ts 's/b64u\(await sha\(c\)\)\.slice\(0, 22\)/c/' tests/review.spec.mjs "R11 link visitors write"  # from = the cookie itself
nc visitor-cookie-only-when-on src/worker/index.ts 's/!acc\.write && acc\.roomWrite && !VISITOR_RE/!acc.write \&\& !VISITOR_RE/' tests/review.spec.mjs "R11 link visitors write"
nc visitor-personal src/worker/index.ts 's/acc\.roomWrite && !personal\(acc\.manifest\) : acc\.write;/acc.roomWrite : acc.write;/' tests/review.spec.mjs "R11 link visitors write"
scripts/dev.sh >/dev/null && echo "restored: clean build running"
exit $FAILS
