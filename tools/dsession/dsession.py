#!/usr/bin/env python3
"""dsession - turn a ds4-agent session into a recording you can watch.

Reads the session files the harness already writes under ~/.ds4/kvcache, joins
them with the decision graph on the deciduous server, and composes a demo: the
decisions as the spine, the code and the command output from the transcript as
the evidence, played back through a compressed version of the session's own
clock.

Commands
    sessions                     list session files, newest first
    extract [path|sha] [-o F]   session transcript as JSON-Lines events
    graph                       graph node counts for this workspace
    demo [path] [-o F]          compose the demo recording
    play F [--speed N]          replay a recording
    render F                    print a recording as text, no terminal needed

Why the marker strings below are assembled from character codes: this file
reads a transcript that is full of the marker names the harness parses out of
an agent's output. Assembling them at runtime means the source can be pasted
into an agent session without the text of the file confusing that parser.

Stdlib only, like dcp.
"""
import argparse
import importlib.machinery
import importlib.util
import json
import os
import re
import sys
import textwrap
import time

LT = chr(60)
GT = chr(62)
IM_START = LT + "|im_start|" + GT
IM_END = LT + "|im_end|" + GT
THINK_OPEN = LT + "think" + GT
THINK_CLOSE = LT + "/think" + GT
RESP_OPEN = LT + "tool" + "_response" + GT
CALL_OPEN = LT + "tool" + "_call" + GT
CALL_CLOSE = LT + "/tool" + "_call" + GT
FN_OPEN = LT + "function="
PARAM_OPEN = LT + "parameter="
PARAM_CLOSE = LT + "/parameter" + GT
COMPACTION = "compacted earlier conversation"

CACHE_DIR = os.path.expanduser("~/.ds4/kvcache")
DCP = os.path.expanduser("~/.local/bin/dcp")

WIDTH = 100
HEIGHT = 26
# A hundred minutes of work should play in about two. Square-root spacing keeps
# the order and the weight of the real clock without asking for a snack break.
FLOOR = 0.45
CEIL = 2.2
SCALE = 0.42
EVIDENCE_EVERY = 3


def kv_files():
    out = []
    for name in os.listdir(CACHE_DIR) if os.path.isdir(CACHE_DIR) else []:
        if not name.endswith(".kv") or name == "sysprompt.kv":
            continue
        path = os.path.join(CACHE_DIR, name)
        out.append((path, os.path.getmtime(path), os.path.getsize(path)))
    return sorted(out, key=lambda t: -t[1])


def resolve(arg):
    files = kv_files()
    if not arg:
        return files[0][0] if files else None
    if os.path.exists(arg):
        return arg
    guess = os.path.join(CACHE_DIR, arg if arg.endswith(".kv") else arg + ".kv")
    return guess if os.path.exists(guess) else None


def read_text(path):
    with open(path, "rb") as fh:
        return fh.read().decode("utf-8", "replace")


def split_messages(text):
    msgs = []
    for part in text.split(IM_START)[1:]:
        nl = part.find("\n")
        if nl < 0:
            continue
        end = part.find(IM_END)
        body = part[nl + 1:end if end >= 0 else len(part)]
        msgs.append((part[:nl].strip(), body))
    return msgs


def carve_assistant(body):
    """Split an assistant message into thinking, prose, and the calls it made."""
    thinks = re.findall(re.escape(THINK_OPEN) + r"(.*?)" + re.escape(THINK_CLOSE),
                        body, re.S)
    calls = []
    for chunk in re.findall(re.escape(CALL_OPEN) + r"(.*?)" + re.escape(CALL_CLOSE),
                            body, re.S):
        fn = re.search(re.escape(FN_OPEN) + r"([A-Za-z0-9_\-]+)" + re.escape(GT),
                       chunk)
        args = {}
        for name, value in re.findall(re.escape(PARAM_OPEN) +
                                      r"([A-Za-z0-9_\-]+)" + re.escape(GT) +
                                      r"(.*?)" + re.escape(PARAM_CLOSE), chunk, re.S):
            args[name] = value.strip("\n ")
        calls.append((fn.group(1) if fn else "?", args))
    prose = re.sub(re.escape(CALL_OPEN) + r".*?" + re.escape(CALL_CLOSE), "", body,
                   flags=re.S)
    prose = re.sub(re.escape(THINK_OPEN) + r".*?" + re.escape(THINK_CLOSE), "",
                   prose, flags=re.S)
    return thinks, prose.strip(), calls


def events_from(path):
    events = []
    for i, (role, body) in enumerate(split_messages(read_text(path))):
        if role == "system":
            continue
        if COMPACTION in body:
            events.append({"seq": i, "kind": "compaction"})
        if role == "user":
            kind = "result" if RESP_OPEN in body else "prompt"
            events.append({"seq": i, "kind": kind, "text": body})
            continue
        thinks, prose, calls = carve_assistant(body)
        for th in thinks:
            if len(th.strip()) > 40:
                events.append({"seq": i, "kind": "thinking", "text": th.strip()})
        if prose:
            events.append({"seq": i, "kind": "text", "text": prose})
        for name, args in calls:
            events.append({"seq": i, "kind": "call", "tool": name, "args": args})
    return events


def title_of(path):
    """The first real prompt. A compacted session opens with the summary, so the
    prompt after the marker is the first thing the session actually said."""
    for role, body in split_messages(read_text(path)[:400000]):
        if role != "user" or RESP_OPEN in body or not body.strip():
            continue
        if COMPACTION in body:
            tail = body.split(COMPACTION, 1)[1]
            for ln in tail.splitlines():
                if ln.strip() and not ln.strip().startswith("["):
                    return ln.strip()[:80]
            continue
        return body.strip().splitlines()[0][:80]
    return "(no prompt)"


def load_dcp():
    """Reuse the operator's graph client instead of reimplementing its handshake.

    dcp has no .py suffix, so the source loader has to be named explicitly.
    """
    if not os.path.exists(DCP):
        sys.exit(f"needs the graph client at {DCP}")
    loader = importlib.machinery.SourceFileLoader("dcp_client", DCP)
    spec = importlib.util.spec_from_loader("dcp_client", loader)
    dcp = importlib.util.module_from_spec(spec)
    loader.exec_module(dcp)
    return dcp


def all_nodes(workspace, branch):
    data = load_dcp().tool_call("query_nodes", {"workspace": workspace,
                                                "branch": branch, "limit": 10000})
    if isinstance(data, dict):
        return data.get("nodes") or data.get("results") or []
    return data or []


def graph_nodes(workspace, branch):
    """Nodes with the text the demo needs.

    query_nodes returns titles and timestamps but no description and no edge
    targets, so the interesting nodes are re-read one at a time and the option
    titles are resolved from the id map built from the cheap listing.
    """
    dcp = load_dcp()
    flat = all_nodes(workspace, branch)
    titles = {n["id"]: n.get("title") or "" for n in flat if n.get("id")}
    want = ("goal", "decision", "outcome", "action", "observation", "turn")
    out = []
    for n in flat:
        if n.get("node_type") not in want:
            continue
        try:
            detail = dcp.tool_call("show_node", {"node_id": n["id"]})
        except SystemExit:
            detail = {}
        if not isinstance(detail, dict):
            detail = {}
        n = dict(n)
        n["description"] = detail.get("description") or ""
        rejected = []
        for e in detail.get("edges_from") or []:
            if e.get("type") == "rejected":
                rejected.append(titles.get(e.get("to"), ""))
        n["rejected"] = [r for r in rejected if r]
        out.append(n)
    return out


def parse_time(iso):
    if not iso:
        return None
    stamp = str(iso).replace("Z", "").split(".")[0]
    try:
        return time.mktime(time.strptime(stamp, "%Y-%m-%dT%H:%M:%S"))
    except ValueError:
        return None


def graph_cards(nodes):
    cards = []
    for n in sorted(nodes, key=lambda x: x.get("created_at") or ""):
        kind = n.get("node_type")
        title = n.get("title") or ""
        desc = n.get("description") or ""
        body = []
        if kind == "goal":
            body = [title]
        elif kind == "decision":
            body.append(title)
            for r in n.get("rejected") or []:
                body.append("- rejected: " + r)
            if desc and desc != title:
                body.append(desc)
        elif kind in ("outcome", "action", "observation", "turn"):
            body = [title] + ([desc] if desc and desc != title else [])
        else:
            continue
        cards.append({"style": kind, "title": title, "lines": body,
                      "t": parse_time(n.get("created_at"))})
    return [c for c in cards if any(l.strip() for l in c["lines"])]


def transcript_evidence(events):
    """The code and the output: what the transcript holds that the graph does not."""
    out = []
    pending = None
    for ev in events:
        kind = ev["kind"]
        if kind == "prompt":
            if COMPACTION in ev["text"]:
                continue
            lines = ev["text"].strip().splitlines()[:3]
            if lines:
                out.append({"title": "PROMPT", "lines": lines})
        elif kind == "call" and ev.get("tool") in ("write", "edit"):
            args = ev.get("args") or {}
            name = (args.get("path") or "?").rsplit("/", 1)[-1]
            body = args.get("content") or args.get("new") or ""
            lines = [l for l in body.splitlines() if l.strip()][:6]
            if lines:
                out.append({"title": "WROTE " + name, "lines": lines})
        elif kind == "call" and ev.get("tool") == "bash":
            cmd = (ev.get("args") or {}).get("command") or ""
            pending = cmd.strip().splitlines()[:1]
        elif kind == "result":
            keep = [l.strip() for l in ev["text"].splitlines()
                    if any(k in l for k in ("pass", "fail", "tests", "error",
                                            "added", "check", "clean"))]
            if pending and keep:
                out.append({"title": "RAN", "lines": pending + keep[:3]})
            pending = None
        elif kind == "thinking" and len(ev["text"]) > 200:
            out.append({"title": "THOUGHT",
                        "lines": ev["text"].strip().splitlines()[:2]})
    return out


def draw(lines, header, footer):
    rows = ["\x1b[H\x1b[2J\x1b[3J", "\x1b[1;36m" + header + "\x1b[0m\x1b[K"]
    rows.append("\x1b[35m" + "-" * (WIDTH - 6) + "\x1b[0m\x1b[K")
    for ln in lines:
        for wrapped in textwrap.wrap(ln, WIDTH - 8) or [""]:
            rows.append("  " + wrapped + "\x1b[K")
    rows.append("\x1b[2m" + footer + "\x1b[0m\x1b[K")
    return "\n".join(rows) + "\n"


def compose(events, nodes, session, workspace, branch):
    cards = graph_cards(nodes)
    ev = transcript_evidence(events)
    head = f"ds4 session {session[:8]}   {workspace}/{branch}"
    scenes = []
    if not cards:
        return scenes
    times = [c["t"] for c in cards if c["t"]]
    start, end = (min(times), max(times)) if times else (None, None)
    intro = [f"session {session}",
             f"{int((end - start) // 60) if start else '?'} minutes of work, "
             f"{len(events)} transcript events, {len(nodes)} graph nodes.",
             "The graph supplies the clock: the session file records the words but "
             "never the time, so transcript samples appear in transcript order, "
             "not aligned to the minute."]
    scenes.append({"text": draw(intro, head, "a recording of the session, not a summary"),
                   "delay": 4.5})
    prev, ei = None, 0
    picks = max(1, len(cards) // EVIDENCE_EVERY)
    stride = max(1, len(ev) // picks) if ev else 0
    for i, c in enumerate(cards):
        lines = [c["style"] + ": " + c["title"]] + [l for l in c["lines"][1:]]
        t = c["t"]
        if prev and t:
            gap = max(0.0, t - prev)
            delay = min(CEIL, max(FLOOR, (gap ** 0.5) * SCALE + 0.3 * len(lines)))
        else:
            delay = 1.2
        prev = t or prev
        stamp = time.strftime("%H:%M", time.localtime(t)) if t else ""
        mins = f"minute {int((t - start) // 60)}" if t and start else ""
        footer = f"from the graph at {stamp} ({mins})   card {i + 1}/{len(cards)}"
        scenes.append({"text": draw(lines, head, footer), "delay": delay})
        if i % EVIDENCE_EVERY == 1 and ev and stride:
            pick = ev[min(ei * stride, len(ev) - 1)]
            ei += 1
            footer = ("from the transcript, sample " + str(ei) +
                      " in transcript order (the session file has no timestamps)")
            scenes.append({"text": draw([pick["title"]] + pick["lines"], head, footer),
                           "delay": 1.5})
    tail = [f"{len(scenes) + 1} scenes, the session clock compressed by square root.",
            "the graph holds the decisions, the session file holds the code."]
    scenes.append({"text": draw(tail, head, "end"), "delay": 2.5})
    return scenes


def write_cast(scenes, path, title):
    header = {"version": 2, "width": WIDTH, "height": HEIGHT,
              "timestamp": int(time.time()), "title": title,
              "env": {"TERM": "xterm-256color", "SHELL": "/bin/bash",
                      "COLUMNS": str(WIDTH), "LINES": str(HEIGHT)}}
    total = 0.0
    with open(path, "w") as fh:
        fh.write(json.dumps(header) + "\n")
        for sc in scenes:
            total += sc["delay"]
            fh.write(json.dumps([round(sc["delay"], 4), "o", sc["text"]]) + "\n")
    return total


def play(path, speed=1.0):
    with open(path) as fh:
        header = json.loads(fh.readline())
        sys.stdout.write(f"\x1b[{header.get('height', 24)}r\x1b[2J\x1b[H")
        for line in fh:
            ev = json.loads(line)
            if ev[1] != "o":
                continue
            time.sleep(ev[0] / max(speed, 0.0001))
            sys.stdout.write(ev[2])
            sys.stdout.flush()
    sys.stdout.write("\x1b[0m\n")


def render(path):
    with open(path) as fh:
        header = json.loads(fh.readline())
        out = [header.get("title", ""), "=" * WIDTH]
        for line in fh:
            ev = json.loads(line)
            if ev[1] == "o":
                out.append(ev[2])
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser(prog="dsession")
    ap.add_argument("cmd", choices=["sessions", "extract", "graph", "demo",
                                    "play", "render"])
    ap.add_argument("arg", nargs="?")
    ap.add_argument("--out")
    ap.add_argument("--speed", type=float, default=1.0)
    args = ap.parse_args()

    if args.cmd == "sessions":
        for path, mtime, size in kv_files():
            print(time.strftime("%m-%d %H:%M", time.localtime(mtime)),
                  f"{size // 1048576:>5}MB", os.path.basename(path)[:16],
                  title_of(path))
        return

    if args.cmd == "extract":
        path = resolve(args.arg)
        if not path:
            sys.exit("no session file found")
        evs = events_from(path)
        if args.out:
            with open(args.out, "w") as fh:
                for ev in evs:
                    fh.write(json.dumps(ev, ensure_ascii=False) + "\n")
            print(f"{len(evs)} events -> {args.out}")
        else:
            for ev in evs:
                sys.stdout.write(json.dumps(ev, ensure_ascii=False) + "\n")
        return

    if args.cmd in ("graph", "demo"):
        dcp = load_dcp()
        ws, br = dcp.resolve_workspace(), dcp.resolve_branch()
        nodes = graph_nodes(ws, br)
        if args.cmd == "graph":
            counts = {}
            for n in nodes:
                counts[n.get("node_type")] = counts.get(n.get("node_type"), 0) + 1
            print(json.dumps(counts, indent=2))
            return
        path = resolve(args.arg)
        session = os.path.splitext(os.path.basename(path or ""))[0]
        scenes = compose(events_from(path) if path else [], nodes, session, ws, br)
        out = args.out or os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                        f"demo-{session[:8]}.cast")
        secs = write_cast(scenes, out, f"ds4 session {session[:8]} recorded")
        print(f"{len(scenes)} scenes, {secs:.0f}s playback -> {out}")
        return

    if args.cmd == "play":
        if not args.arg:
            sys.exit("need a recording")
        play(args.arg, args.speed)
        return

    if args.cmd == "render":
        if not args.arg:
            sys.exit("need a recording")
        print(render(args.arg))


if __name__ == "__main__":
    main()
