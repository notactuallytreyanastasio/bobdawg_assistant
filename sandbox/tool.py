"""One tool call, inside the sandbox. A JSON request comes in on stdin and a JSON answer goes out
on stdout. Paths are only made safe enough to give a clear error: this process has nothing to
guard, as the container around it is the boundary, and the host never touches these files."""

import fnmatch
import json
import os
import re
import shutil
import signal
import subprocess
import sys

OUTPUT_CHARS = 30000
READ_LINES = 400
SEARCH_RESULTS = 100
BASH_SECONDS = 60
BASH_SECONDS_MAX = 280
SKIPPED_DIRS = {".git", "node_modules", "__pycache__", ".venv"}
TREE_FILES = 500
SNAPSHOTS = "/snapshots"
SNAPSHOTS_KEPT = 5
SNAPSHOT_BYTES = 200 * 1024 * 1024


def clip(text):
    if len(text) <= OUTPUT_CHARS:
        return text
    half = OUTPUT_CHARS // 2
    return f"{text[:half]}\n[{len(text) - OUTPUT_CHARS} characters left out]\n{text[-half:]}"


def inside(path):
    full = os.path.normpath(os.path.join("/work", path or "."))
    if full != "/work" and not full.startswith("/work/"):
        raise ValueError(f"{path} is outside the workspace")
    return full


def bash(args):
    command = args["command"]
    limit = min(int(args.get("timeout_sec") or BASH_SECONDS), BASH_SECONDS_MAX)
    process = subprocess.Popen(
        ["/bin/bash", "-c", command], cwd="/work", stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True,
    )
    try:
        output, _ = process.communicate(timeout=limit)
        note = f"[exit {process.returncode}]"
        ok = process.returncode == 0
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        output, _ = process.communicate()
        note = f"[killed after {limit} seconds]"
        ok = False
    return ok, f"{clip(output.decode('utf8', 'replace'))}\n{note}".lstrip()


def read(args):
    path = inside(args["path"])
    with open(path, encoding="utf8", errors="replace") as source:
        lines = source.readlines()
    start = max(int(args.get("start_line") or 1), 1)
    count = min(int(args.get("max_lines") or READ_LINES), READ_LINES)
    if args.get("raw"):
        return True, clip("".join(lines))
    shown = lines[start - 1:start - 1 + count]
    body = "".join(f"{start + i}\t{line}" for i, line in enumerate(shown))
    rest = len(lines) - (start - 1 + len(shown))
    return True, clip(body) + (f"\n[{rest} more lines; start_line={start + len(shown)}]" if rest > 0 else "")


def write(args):
    path = inside(args["path"])
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf8") as target:
        target.write(args["content"])
    return True, f"wrote {len(args['content'])} characters to {args['path']}"


def edit(args):
    path = inside(args["path"])
    old, new = args["old"], args["new"]
    if not old:
        raise ValueError("old must not be empty")
    with open(path, encoding="utf8") as source:
        text = source.read()
    found = text.count(old)
    if found == 0:
        return False, "old text not found: read the file and copy it exactly"
    if found > 1 and not args.get("all"):
        return False, f"old text matches {found} times: add context, or set all to true"
    with open(path, "w", encoding="utf8") as target:
        target.write(text.replace(old, new))
    return True, f"replaced {found} match{'' if found == 1 else 'es'} in {args['path']}"


def listing(args):
    path = inside(args.get("path"))
    rows = []
    for name in sorted(os.listdir(path)):
        full = os.path.join(path, name)
        kind = "/" if os.path.isdir(full) else ""
        size = "" if kind else f"\t{os.path.getsize(full)}"
        rows.append(f"{name}{kind}{size}")
    return True, clip("\n".join(rows)) or "(empty)"


def search(args):
    pattern = re.compile(args["query"] if args.get("regex") else re.escape(args["query"]))
    glob = args.get("glob")
    found = []
    for folder, dirs, files in os.walk(inside(args.get("path"))):
        dirs[:] = [d for d in dirs if d not in SKIPPED_DIRS]
        for name in files:
            if glob and not fnmatch.fnmatch(name, glob):
                continue
            full = os.path.join(folder, name)
            try:
                with open(full, encoding="utf8") as source:
                    for number, line in enumerate(source, 1):
                        if pattern.search(line):
                            found.append(f"{os.path.relpath(full, '/work')}:{number}:{line.rstrip()[:200]}")
                            if len(found) >= SEARCH_RESULTS:
                                return True, "\n".join(found) + "\n[more matches left out]"
            except (UnicodeDecodeError, OSError):
                continue
    return True, "\n".join(found) or "no matches"


def tree(args):
    rows = []
    for folder, dirs, files in os.walk("/work"):
        dirs[:] = sorted(d for d in dirs if d not in SKIPPED_DIRS)
        for name in sorted(files):
            full = os.path.join(folder, name)
            if os.path.isfile(full) and len(rows) < TREE_FILES:
                rows.append(f"{os.path.relpath(full, '/work')}\t{os.path.getsize(full)}")
    return True, "\n".join(rows)


def held():
    return sorted((int(name) for name in os.listdir(SNAPSHOTS) if name.isdigit()))


def bytes_in(path):
    return sum(os.path.getsize(os.path.join(folder, name)) for folder, _, files in os.walk(path)
               for name in files if os.path.isfile(os.path.join(folder, name)))


def snapshot(args):
    """The whole directory as a turn found it. A copy of everything, so it answers for what
    bash did as well as the file tools, and it lives on a volume of its own so that it is
    never in the model's way or in a git add."""
    if bytes_in("/work") > SNAPSHOT_BYTES:
        return False, "the workspace is too large to keep a copy of"
    taken = held()
    number = (taken[-1] + 1) if taken else 1
    target = f"{SNAPSHOTS}/{number}"
    os.makedirs(f"{target}.part", exist_ok=True)
    subprocess.run(["cp", "-a", "/work/.", f"{target}.part/"], check=True)
    os.rename(f"{target}.part", target)
    for old in held()[:-SNAPSHOTS_KEPT]:
        shutil.rmtree(f"{SNAPSHOTS}/{old}", ignore_errors=True)
    return True, f"kept {number}"


def restore(args):
    taken = held()
    if not taken:
        return False, "nothing to undo"
    source = f"{SNAPSHOTS}/{taken[-1]}"
    for name in os.listdir("/work"):
        full = os.path.join("/work", name)
        if os.path.isdir(full) and not os.path.islink(full):
            shutil.rmtree(full)
        else:
            os.remove(full)
    subprocess.run(["cp", "-a", f"{source}/.", "/work/"], check=True)
    shutil.rmtree(source)
    return True, "the workspace is back as it was before the last turn"


TOOLS = {"bash": bash, "read": read, "write": write, "edit": edit, "list": listing, "search": search,
         "tree": tree, "snapshot": snapshot, "restore": restore}


def main():
    try:
        request = json.load(sys.stdin)
        ok, text = TOOLS[request["tool"]](request.get("args") or {})
    except KeyError as missing:
        ok, text = False, f"missing or unknown: {missing}"
    except (OSError, ValueError, re.error, TypeError, subprocess.CalledProcessError) as reason:
        ok, text = False, str(reason)
    json.dump({"ok": ok, "text": text}, sys.stdout)


main()
