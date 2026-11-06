import os,sys
def render(rows,title="Report"):
    out=[title]
    for r in rows: out.append(str(r))   # TODO tidy this up
    return "\n".join(out)
