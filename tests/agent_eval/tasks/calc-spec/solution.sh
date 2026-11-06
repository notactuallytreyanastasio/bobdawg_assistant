cat > calc.py <<'P'
import re


class CalcError(Exception):
    pass


TOKEN = re.compile(r"\s*(?:(\d+\.\d*|\.\d+|\d+)|([A-Za-z_]\w*)|(.))")


def tokens(text):
    out = []
    for number, name, other in TOKEN.findall(text.rstrip()):
        if number:
            if number.count(".") > 1:
                raise CalcError("bad number")
            out.append(("n", float(number) if "." in number else int(number)))
        elif name:
            out.append(("w", name))
        elif other:
            out.append(("o", other))
    return out


class P:
    def __init__(self, t):
        self.t, self.i = t, 0

    def peek(self):
        return self.t[self.i] if self.i < len(self.t) else (None, None)

    def eat(self, v):
        if self.peek() == ("o", v):
            self.i += 1
            return True
        return False

    def expr(self):
        v = self.term()
        while True:
            if self.eat("+"):
                v += self.term()
            elif self.eat("-"):
                v -= self.term()
            else:
                return v

    def term(self):
        v = self.unary()
        while True:
            if self.eat("*"):
                v *= self.unary()
            elif self.eat("/"):
                d = self.unary()
                if d == 0:
                    raise CalcError("division by zero")
                v = v / d
            elif self.eat("%"):
                d = self.unary()
                if d == 0:
                    raise CalcError("modulo by zero")
                v %= d
            else:
                return v

    def unary(self):
        if self.eat("-"):
            return -self.unary()
        return self.power()

    def power(self):
        v = self.atom()
        if self.eat("^"):
            return v ** self.unary()
        return v

    def atom(self):
        kind, v = self.peek()
        if kind == "n":
            self.i += 1
            return v
        if kind == "w":
            self.i += 1
            if v == "pi":
                return 3.141592653589793
            if v not in ("min", "max", "abs") or not self.eat("("):
                raise CalcError(f"unknown name {v}")
            args = []
            if not self.eat(")"):
                args.append(self.expr())
                while self.eat(","):
                    args.append(self.expr())
                if not self.eat(")"):
                    raise CalcError("expected )")
            if not args or (v == "abs" and len(args) != 1):
                raise CalcError("wrong arguments")
            return {"min": min, "max": max}.get(v, lambda *a: abs(a[0]))(*args)
        if self.eat("("):
            r = self.expr()
            if not self.eat(")"):
                raise CalcError("expected )")
            return r
        raise CalcError("unexpected input")


def evaluate(text):
    p = P(tokens(text))
    try:
        r = p.expr()
    except (OverflowError, ZeroDivisionError, TypeError) as reason:
        raise CalcError(str(reason))
    if p.i != len(p.t):
        raise CalcError("unexpected input")
    return r
P
