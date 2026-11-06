from greet import greet, initials
from names import display_name, sort_key

ada = {"id": 1, "name": "Ada Lovelace"}
assert display_name(ada) == "Ada Lovelace"
assert greet(ada) == "Hello, Ada Lovelace!"
assert initials(ada) == "AL"
assert sort_key(ada) == "lovelace"
print("ok")
