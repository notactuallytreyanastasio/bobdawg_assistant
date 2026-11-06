test "$(tr -d ' \n' < ANSWER.txt)" = 8 || { echo "wrong answer: $(cat ANSWER.txt 2>/dev/null)"; exit 1; }
git diff --quiet HEAD -- src || { echo "changed the code"; exit 1; }
