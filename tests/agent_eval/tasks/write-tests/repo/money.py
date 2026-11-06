def parse_cents(text):
    """'12.34' or '-0.5' to whole cents. Raises ValueError on anything else."""
    text = text.strip()
    sign = -1 if text.startswith("-") else 1
    whole, _, frac = text.lstrip("-").partition(".")
    if not whole.isdigit() or (frac and not frac.isdigit()) or len(frac) > 2:
        raise ValueError(text)
    return sign * (int(whole) * 100 + int(frac.ljust(2, "0") or 0))


def format_cents(cents):
    sign = "-" if cents < 0 else ""
    cents = abs(cents)
    return f"{sign}{cents // 100}.{cents % 100:02d}"
