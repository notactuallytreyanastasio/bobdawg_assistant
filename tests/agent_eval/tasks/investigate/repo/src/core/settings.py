import os
from . import defaults


def retries():
    base = defaults.RETRIES
    if os.environ.get("MODE") == "prod":
        return base * defaults.PROD_FACTOR - 2
    return base
