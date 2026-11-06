#!/bin/bash
# Run the coding tasks in tasks/ through ds4-agent and score them. Each task starts from a
# fresh git repository holding repo/, and the model sees only prompt.txt. check.sh stays
# outside its reach, runs in the result afterwards, and exit 0 is a pass.
#
# Usage: tests/agent_eval/run.sh [-n RUNS] [-o RESULTS.tsv] [task ...]
# Needs the model, so nothing else may be holding it: stop ds4-server first.
set -u
here="$(cd "$(dirname "$0")" && pwd)"
agent="$here/../../ds4-agent"
runs=1
out=""
limit="${DS4_EVAL_SECONDS:-360}"
while getopts "n:o:" flag; do
  case "$flag" in
    n) runs="$OPTARG" ;;
    o) out="$OPTARG" ;;
    *) exit 2 ;;
  esac
done
shift $((OPTIND - 1))
if [ $# -eq 0 ]; then
  set -- $(cd "$here/tasks" && ls)
fi
work="$(mktemp -d "${TMPDIR:-/tmp}/ds4-eval-XXXXXX")"
passed=0
total=0
[ -n "$out" ] && printf 'task\trun\tresult\tseconds\tnote\n' > "$out"
for task in "$@"; do
  for run in $(seq 1 "$runs"); do
    dir="$work/$task-$run"
    mkdir -p "$dir"
    cp -R "$here/tasks/$task/repo/." "$dir/"
    (cd "$dir" && git init -q -b main && git add -A &&
     git -c user.name=eval -c user.email=eval@example.com commit -q -m start)
    began=$(date +%s)
    "$here/timeout.py" "$limit" "$agent" --ctx 32768 --graph off --hooks off --instructions off \
      --permissions all --chdir "$dir" --non-interactive --prompt-file "$here/tasks/$task/prompt.txt" \
      > "$dir.log" 2>&1
    status=$?
    seconds=$(( $(date +%s) - began ))
    note="$(cd "$dir" && sh -e "$here/tasks/$task/check.sh" 2>&1)"
    checked=$?
    note="$(printf '%s' "$note" | tail -1)"
    if [ "$status" -eq 124 ]; then
      result=fail; note="timed out"
    elif [ "$checked" -eq 0 ]; then
      result=pass; note=""
    else
      result=fail
    fi
    total=$((total + 1))
    [ "$result" = pass ] && passed=$((passed + 1))
    printf '%-16s %d %-4s %4ss %s\n' "$task" "$run" "$result" "$seconds" "$note"
    [ -n "$out" ] && printf '%s\t%d\t%s\t%d\t%s\n' "$task" "$run" "$result" "$seconds" "$note" >> "$out"
  done
done
echo "passed $passed of $total; logs in $work"
[ "$passed" -eq "$total" ]
