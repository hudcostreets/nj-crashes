from os.path import join, exists

from atproto import Client
from os import environ as env

from dotenv import dotenv_values

from nj_crashes import ROOT_DIR

USER_VAR = 'BSKY_USER'
PASS_VAR = 'BSKY_PASS'

_client = None
def client():
    global _client
    if not _client:
        _client = Client()
        user = env.get(USER_VAR)
        pswd = env.get(PASS_VAR)
        if not user or not pswd:
            path = join(ROOT_DIR, ".bsky.env")
            if exists(path):
                config = dotenv_values(path)
                if not user:
                    user = config.get(USER_VAR)
                if not pswd:
                    pswd = config.get(PASS_VAR)
                if not user or not pswd:
                    raise RuntimeError(f"Missing ${USER_VAR} or ${PASS_VAR}, including in {path}")
            else:
                raise RuntimeError(f"Missing ${USER_VAR} or ${PASS_VAR}, and {path} doesn't exist")
        _client.login(user, pswd)
    return _client
