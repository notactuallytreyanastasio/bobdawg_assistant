python3 - <<'P' || { echo "used eval"; exit 1; }
import ast
tree=ast.parse(open("calc.py").read())
own={n.name for n in ast.walk(tree) if isinstance(n,(ast.FunctionDef,ast.ClassDef))}
for n in ast.walk(tree):
    if isinstance(n,ast.Call) and isinstance(n.func,ast.Name) and n.func.id in("eval","exec") and n.func.id not in own:
        raise SystemExit(1)
P
python3 - <<'P' || { echo "wrong result"; exit 1; }
from calc import evaluate as e, CalcError
for t,w in [("1+2*3",7),("(1+2)*3",9),("2^3^2",512),("-2^2",-4),("2^-1",0.5),(".5+.5",1.0),("7%3",1),("4/2",2.0),("  1 +  1 ",2),
            ("min(3,1,2)",1),("max(1,2+3)",5),("abs(-4)",4),("--3",3),("-(1+2)",-3),("2*-3",-6),("pi*0",0.0),("10-3-2",5),("100/10/5",2.0),("2^2*3",12),("-3%2",(-3)%2)]:
    g=e(t); assert g==w and type(g)==type(w),(t,g,w)
assert abs(e("pi")-3.141592653589793)<1e-12
for t in ["","1 2","(1","1)","1/0","1%0","foo","abs(1,2)","abs()","min()","1+","*2","2^","1..2","max(1,)","()","1 + @"]:
    try: g=e(t)
    except CalcError as r: assert str(r),t
    else: raise AssertionError((t,g))
P
