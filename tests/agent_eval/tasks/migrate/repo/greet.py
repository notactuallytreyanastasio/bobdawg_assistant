from names import display_name


def greet(user):
    return f"Hello, {display_name(user)}!"


def initials(user):
    return "".join(word[0] for word in user["name"].split())
