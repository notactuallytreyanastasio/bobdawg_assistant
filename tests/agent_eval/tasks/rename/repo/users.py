def get_usr(uid):
    return {"id": uid}


def get_usr_name(uid):
    return get_usr(uid).get("name", "nobody")
