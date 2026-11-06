def page_count(items, per_page):
    """How many pages it takes to show items, per_page at a time."""
    return items // per_page


def page_slice(rows, page, per_page):
    """The rows on a page, counting pages from 1."""
    start = page * per_page
    return rows[start:start + per_page]
