from core import settings

MAX_CAP = 8


def limit():
    return min(settings.retries(), MAX_CAP)
