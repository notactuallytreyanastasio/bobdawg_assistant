python3 test_users.py >/dev/null || { echo "its tests fail"; exit 1; }
python3 - <<'P' || { echo "wrong result"; exit 1; }
import json
from store import load_all
from greet import greet, initials
from names import display_name, sort_key
u={x["id"]:x for x in load_all()}
assert not any("name" in x for x in u.values())
assert (u[2]["first"],u[2]["last"])==("Mary Ann","Evans") and (u[3]["first"],u[3]["last"])==("Cher","")
assert u[9]["role"]=="admin" and u[9]["last"]=="Turing"
assert display_name(u[3])=="Cher" and greet(u[2])=="Hello, Mary Ann Evans!"
assert initials(u[2])=="MAE" and initials(u[3])=="C" and sort_key(u[3])=="cher" and sort_key(u[1])=="lovelace"
try: display_name({"id":5,"name":"Old Style"})
except KeyError: pass
else: raise AssertionError("fell back")
P
