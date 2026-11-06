python3 - <<'P'
import glob,json
for p in glob.glob('data/*.json'):
    rows=json.load(open(p))
    for r in rows:
        a,_,b=r.pop('name').rpartition(' ')
        r['first'],r['last']=(a,b) if a else (b,'')
    json.dump(rows,open(p,'w'))
P
printf 'def display_name(user):\n    return f"{user[\"first\"]} {user[\"last\"]}".strip()\n\n\ndef sort_key(user):\n    return display_name(user).split()[-1].lower()\n' > names.py
printf 'from names import display_name\n\n\ndef greet(user):\n    return f"Hello, {display_name(user)}!"\n\n\ndef initials(user):\n    return "".join(word[0] for word in display_name(user).split())\n' > greet.py
sed -i.bak 's/"name": "Ada Lovelace"/"first": "Ada", "last": "Lovelace"/' test_users.py; rm -f test_users.py.bak
