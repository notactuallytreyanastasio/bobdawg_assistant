git rev-parse --verify -q fix-typo >/dev/null || { echo "no branch"; exit 1; }
git show fix-typo:notes.md | grep -q receive || { echo "not fixed on the branch"; exit 1; }
git show main:notes.md | grep -q recieve || { echo "main changed"; exit 1; }
test "$(git rev-list --count main..fix-typo)" = 1 || { echo "not one commit"; exit 1; }
