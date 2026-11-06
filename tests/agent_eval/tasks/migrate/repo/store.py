import glob
import json


def load_all():
    users = []
    for path in sorted(glob.glob("data/*.json")):
        with open(path) as source:
            users.extend(json.load(source))
    return users
