from functools import wraps

import click
from inspect import getfullargspec


def parse_opt(*args, parse, kw, **kwargs):
    spec = getfullargspec(parse)
    arg = spec.args[0]
    def opt(fn):
        @click.option(*args, arg, **kwargs)
        @wraps(fn)
        def _fn(*args, **kwargs):
            str_val = kwargs.pop(arg)
            return fn(*args, **{ kw: parse(str_val) }, **kwargs)
        return _fn
    return opt
