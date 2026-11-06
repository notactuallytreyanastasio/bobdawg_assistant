printf 'x y y z z z\n' > in.tmp
test "$(python3 wordcount.py in.tmp --reverse | head -1)" = "1 x" || { echo "--reverse wrong"; exit 1; }
test "$(python3 wordcount.py in.tmp | head -1)" = "3 z" || { echo "default order broke"; exit 1; }
sh test_wordcount.sh >/dev/null || { echo "test script fails"; exit 1; }
grep -q -e --reverse test_wordcount.sh || { echo "no test added"; exit 1; }
