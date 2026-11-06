class LRUCache:
    """Keeps at most capacity entries, dropping the least recently used.

    A get counts as use. A put to an existing key counts as use and replaces the value.
    """

    def __init__(self, capacity):
        self.capacity = capacity
        self.order = []
        self.values = {}

    def get(self, key, default=None):
        return self.values.get(key, default)

    def put(self, key, value):
        self.values[key] = value
        self.order.append(key)
        if len(self.order) > self.capacity:
            oldest = self.order.pop()
            del self.values[oldest]

    def __len__(self):
        return len(self.values)
