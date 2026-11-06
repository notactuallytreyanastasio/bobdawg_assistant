def display_name(user):
    return user["name"]


def sort_key(user):
    return user["name"].split()[-1].lower()
