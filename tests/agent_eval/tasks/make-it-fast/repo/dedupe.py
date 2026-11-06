def dedupe_sessions(events):
    """events are (user, timestamp) pairs. Keep the first event of each user, then any later
    event of that user at least 30 seconds after the last one kept. Output keeps input order."""
    kept = []
    for user, stamp in events:
        last = None
        for other_user, other_stamp in kept:
            if other_user == user:
                last = other_stamp
        if last is None or stamp - last >= 30:
            kept.append((user, stamp))
    return kept
