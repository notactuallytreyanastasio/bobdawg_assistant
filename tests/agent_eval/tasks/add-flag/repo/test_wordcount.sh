#!/bin/sh
set -e
printf 'a b b c c c\n' > /tmp/wc_$$.txt
test "$(python3 wordcount.py /tmp/wc_$$.txt | head -1)" = "3 c"
rm -f /tmp/wc_$$.txt
echo ok
