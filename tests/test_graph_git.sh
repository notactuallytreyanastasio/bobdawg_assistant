#!/bin/sh
# The git hooks end to end: real git, the real ds4-graph, the real deciduous server, in a
# throwaway repository writing to the ds4-selftest workspace. It skips itself, saying
# why, when that server cannot be reached.
set -u
repo_root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d /tmp/ds4-gitgraph-XXXXXX)
trap 'rm -rf "$work"' EXIT
# A branch per run: the last run's repository is gone, so its hashes really are stale.
export DECIDUOUS_WORKSPACE=ds4-selftest DECIDUOUS_BRANCH=githooks-selftest-$$-$(date +%s)
unset DS4_DEC_GOAL
export DS4_GRAPH_LOCAL=1 # ~/.ds4/graph may name a real graph
failed=0
check() { # check "what" command...
  what=$1; shift
  if "$@" >"$work/out" 2>&1; then echo "ok   $what"; else echo "FAIL $what"; sed 's/^/     /' "$work/out"; failed=1; fi
}
refuses() { what=$1; shift
  if "$@" >"$work/out" 2>&1; then echo "FAIL $what (it was allowed)"; failed=1; else echo "ok   $what"; fi
}

git init -q --bare "$work/remote.git"
git init -q "$work/repo"
cd "$work/repo" || exit 1
git config user.email t@t; git config user.name t
git remote add fork "$work/remote.git"
cp -R "$repo_root/githooks" githooks
cp "$repo_root/ds4-graph" ds4-graph
printf 'ds4-graph\n' > .gitignore
./ds4-graph install >/dev/null
if ! ./ds4-graph audit HEAD >"$work/out" 2>&1 && grep -q 'not complete the handshake\|no deciduous' "$work/out"; then
  echo "skipped: deciduous server not reachable"; exit 0
fi

# A goal to work under, made the way the agent makes one.
goal=$(./ds4-graph goal "githooks selftest $$") || { echo "FAIL could not write a goal"; exit 1; }

echo one > a; git add -A
DS4_DEC_GOAL=$goal git commit -q -m "linked change $$"
check "commit-msg stamps the session's goal" sh -c "git log -1 --format=%B | grep -q 'Deciduous-Goal: $goal'"
check "post-commit links it, so the audit is clean" ./ds4-graph audit HEAD

echo two >> a; git add -A
git commit -q -m "by hand, no goal $$"
refuses "pre-push refuses a commit no node names" git push -q fork HEAD:refs/heads/main

check "linking by hand clears it" ./ds4-graph link "$goal" HEAD
check "the same push now goes through" git push -q fork HEAD:refs/heads/main

old=$(git rev-parse HEAD)
echo three >> a; git add -A
DS4_DEC_GOAL=$goal git commit -q --amend -m "by hand, no goal $$" >"$work/amend" 2>&1
new=$(git rev-parse HEAD)
if grep -q 'not linked' "$work/amend"; then echo "FAIL an amend was refused:"; cat "$work/amend"; failed=1; else echo "ok   an amend relinks without complaint"; fi
check "post-rewrite moved the graph to the amended hash" ./ds4-graph audit "$new"
if ./ds4-graph audit HEAD 2>&1 | grep -q "$old"; then echo "FAIL the old hash is still named"; failed=1; else echo "ok   the old hash is gone from the graph"; fi

echo four > b; git add -A
DS4_DEC_GOAL=$goal git commit -q -m "second linked $$"
echo five > c; git add -A
DS4_DEC_GOAL=$goal git commit -q -m "third linked $$"
GIT_EDITOR=true git rebase -q --force-rebase HEAD~2 >/dev/null 2>&1
check "a rebase keeps every commit linked" ./ds4-graph audit HEAD~2..HEAD

DECIDUOUS_MCP_URL=http://127.0.0.1:9/mcp DECIDUOUS_MCP_TOKEN=x
export DECIDUOUS_MCP_URL DECIDUOUS_MCP_TOKEN
echo six > d; git add -A
check "a commit still works with the server down" git commit -q -m "offline $$"
refuses "a push cannot be vouched for with the server down" git push -q --force fork HEAD:refs/heads/main

[ "$failed" = 0 ] && echo "graph git hooks: ok"
exit "$failed"
