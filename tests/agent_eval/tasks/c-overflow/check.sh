cc -g -fsanitize=address -o join.asan join.c 2>/dev/null || { echo "does not build"; exit 1; }
big=$(python3 -c "print('x'*5000)")
test "$(ASAN_OPTIONS=detect_leaks=0 ./join.asan a b)" = "a,b (3)" || { echo "wrong output"; exit 1; }
test "$(ASAN_OPTIONS=detect_leaks=0 ./join.asan)" = " (0)" || { echo "wrong with no arguments"; exit 1; }
ASAN_OPTIONS=detect_leaks=0 ./join.asan "$big" "$big" "$big" >/dev/null 2>&1 || { echo "still crashes on long input"; exit 1; }
rm -f join.asan; rm -rf join.asan.dSYM
