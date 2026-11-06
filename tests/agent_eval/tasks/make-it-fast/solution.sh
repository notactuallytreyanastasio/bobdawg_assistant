cat > dedupe.py <<'P'
def dedupe_sessions(events):
    last = {}
    kept = []
    for user, stamp in events:
        if user not in last or stamp - last[user] >= 30:
            kept.append((user, stamp))
            last[user] = stamp
    return kept
P
