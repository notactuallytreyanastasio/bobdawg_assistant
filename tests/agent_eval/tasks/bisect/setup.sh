c(){ git add -A; git -c user.name=dev -c user.email=dev@example.com commit -q -m "$1"; }
for i in 1 2 3 4; do printf '# note %s\n' $i >> shop.py; c "Note $i"; done
sed -i.bak 's/(1 - discount)/(1 - discount \/ 100)/' shop.py; rm -f shop.py.bak; c "Tidy the pricing maths"
for i in 5 6 7; do printf '# note %s\n' $i >> shop.py; c "Note $i"; done
printf 'def tax(total):\n    return round(total * 0.2, 2)\n' >> shop.py; c "Add tax"
for i in 8 9; do printf '# note %s\n' $i >> shop.py; c "Note $i"; done
