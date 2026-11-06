test "$(git log -1 --format=%s "$(tr -d ' \n' < ANSWER.txt)" 2>/dev/null)" = "Tidy the pricing maths" || { echo "wrong commit"; exit 1; }
test "$(tr -d ' \n' < ANSWER.txt | wc -c | tr -d ' ')" = 40 || { echo "not a full hash"; exit 1; }
python3 -c "from shop import total_price as t,tax; assert t([(10,2)],0.25)==15.0 and tax(10)==2.0" || { echo "not fixed, or lost the later work"; exit 1; }
