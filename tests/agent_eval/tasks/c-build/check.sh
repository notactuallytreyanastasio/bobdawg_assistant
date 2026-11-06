rm -f greet *.o; make >/dev/null 2>&1 || { echo "make fails"; exit 1; }
test "$(./greet Ann)" = "Hello, Ann!" || { echo "wrong output: $(./greet Ann)"; exit 1; }
