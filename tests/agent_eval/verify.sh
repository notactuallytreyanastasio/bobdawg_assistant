#!/bin/bash
# Prove the tasks fair without the model: each check must fail on the untouched repository, and
# pass on the reference solution where there is one. A task nothing can pass would read as the
# model failing.
here="$(cd "$(dirname "$0")" && pwd)"
bad=0
for path in "$here"/tasks/*/; do
  task="$(basename "$path")"
  dir="$(mktemp -d)"
  cp -R "$path/repo/." "$dir/"
  (cd "$dir" && git init -q -b main && git add -A && git -c user.name=e -c user.email=e@example.com commit -q -m start)
  [ -f "$path/setup.sh" ] && (cd "$dir" && sh "$path/setup.sh")
  (cd "$dir" && sh -e "$path/check.sh") >/dev/null 2>&1 && { echo "$task: passes untouched"; bad=1; }
  if [ -f "$path/solution.sh" ]; then
    (cd "$dir" && sh "$path/solution.sh")
    note="$(cd "$dir" && sh -e "$path/check.sh" 2>&1)" || { echo "$task: solution fails: $(printf '%s' "$note" | tail -2)"; bad=1; }
  fi
  rm -rf "$dir"
done
[ "$bad" = 0 ] && echo "all tasks fair"
exit "$bad"
