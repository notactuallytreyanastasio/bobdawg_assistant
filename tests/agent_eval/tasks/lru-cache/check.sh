python3 - <<'P' || { echo "wrong behaviour"; exit 1; }
import random
from cache import LRUCache
c=LRUCache(2); c.put("a",1); c.put("b",2); c.get("a"); c.put("c",3)
assert c.get("b") is None and c.get("a")==1 and c.get("c")==3
c=LRUCache(2); c.put("a",1); c.put("b",2); c.put("a",9); c.put("c",3)
assert c.get("a")==9 and c.get("b") is None
c=LRUCache(1); c.put("a",1); c.put("a",2); assert len(c)==1 and c.get("a")==2
c=LRUCache(2); assert c.get("x","d")=="d"; c.put("v",None); assert c.get("v","d") is None
c=LRUCache(2); c.put("a",1); c.put("b",2); c.get("missing"); c.put("c",3); assert c.get("a") is None
rng=random.Random(7); model=[]; c=LRUCache(5); vals={}
for i in range(5000):
    k=rng.randrange(12)
    if rng.random()<.5:
        c.put(k,i); vals[k]=i
        if k in model: model.remove(k)
        model.append(k)
        if len(model)>5: del vals[model.pop(0)]
    else:
        got=c.get(k,"none")
        assert got==vals.get(k,"none"),(i,k)
        if k in model: model.remove(k); model.append(k)
    assert len(c)==len(model)<=5
P
