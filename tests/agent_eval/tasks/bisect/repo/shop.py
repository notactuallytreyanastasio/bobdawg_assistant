def total_price(items, discount):
    subtotal = sum(price * count for price, count in items)
    return round(subtotal * (1 - discount), 2)
