from cache import LRUCache

c = LRUCache(2)
c.put("a", 1)
assert c.get("a") == 1
assert len(c) == 1
print("ok")
