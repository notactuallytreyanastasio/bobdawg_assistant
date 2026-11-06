git log --format='%H %s' | grep 'Tidy the pricing' | cut -d' ' -f1 > ANSWER.txt
sed -i.bak 's/(1 - discount \/ 100)/(1 - discount)/' shop.py; rm -f shop.py.bak
