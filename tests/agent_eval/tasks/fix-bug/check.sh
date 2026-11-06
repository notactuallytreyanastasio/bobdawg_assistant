git diff --quiet HEAD -- test_pager.py || { echo "changed the tests"; exit 1; }
python3 test_pager.py >/dev/null || { echo "tests still fail"; exit 1; }
python3 -c "from pager import page_count as p; assert p(21,7)==3 and p(22,7)==4" || { echo "wrong on other input"; exit 1; }
