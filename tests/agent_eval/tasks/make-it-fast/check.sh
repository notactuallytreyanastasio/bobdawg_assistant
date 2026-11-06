python3 - <<'P' || { echo "too slow or wrong"; exit 1; }
import random,time
from dedupe import dedupe_sessions as f
def slow(events):
    kept=[]
    for u,s in events:
        l=None
        for a,b in kept:
            if a==u: l=b
        if l is None or s-l>=30: kept.append((u,s))
    return kept
r=random.Random(3)
for n in range(300):
    ev=[(r.randrange(5),r.randrange(-50,200)) for _ in range(r.randrange(40))]
    assert f(ev)==slow(ev),ev
big=[(r.randrange(50000),i//3) for i in range(200000)]
t=time.time(); out=f(big); assert time.time()-t<2,"slow"
assert isinstance(out,list)
P
