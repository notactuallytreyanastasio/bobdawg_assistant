import users


def run(ids):
    return [users.get_usr(i) for i in ids]
