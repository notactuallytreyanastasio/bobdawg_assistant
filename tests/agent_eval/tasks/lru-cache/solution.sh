cat > cache.py <<'P'
from collections import OrderedDict


class LRUCache:
    def __init__(self, capacity):
        self.capacity = capacity
        self.values = OrderedDict()

    def get(self, key, default=None):
        if key not in self.values:
            return default
        self.values.move_to_end(key)
        return self.values[key]

    def put(self, key, value):
        self.values[key] = value
        self.values.move_to_end(key)
        if len(self.values) > self.capacity:
            self.values.popitem(last=False)

    def __len__(self):
        return len(self.values)
P
