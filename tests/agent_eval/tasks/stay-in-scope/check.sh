n=$(git diff --numstat HEAD | awk '{a+=$1;d+=$2} END {print a+0, d+0}')
test "$n" = "1 1" || { echo "changed more than one line: $n"; exit 1; }
grep -q 'title="Summary"' report.py || { echo "title not changed"; exit 1; }
test -z "$(git status --porcelain | grep -v '^ M report.py' | grep -v __pycache__)" || { echo "touched other files"; exit 1; }
