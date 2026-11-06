git diff --quiet HEAD -- money.py || { echo "changed money.py"; exit 1; }
python3 test_money.py >/dev/null 2>&1 || { echo "its tests fail on good code"; exit 1; }
cp money.py money.good
sed 's/sign = -1 if/sign = 1 if/' money.good > money.py; python3 test_money.py >/dev/null 2>&1 && { cp money.good money.py; echo "missed a sign mutant"; exit 1; }
sed 's/ljust(2, "0")/rjust(2, "0")/' money.good > money.py; python3 test_money.py >/dev/null 2>&1 && { cp money.good money.py; echo "missed a padding mutant"; exit 1; }
sed 's/len(frac) > 2/len(frac) > 3/' money.good > money.py; python3 test_money.py >/dev/null 2>&1 && { cp money.good money.py; echo "missed a length mutant"; exit 1; }
cp money.good money.py
