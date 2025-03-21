from functools import wraps

from click import group, option, pass_context
from git import Repo
from utz import env, err, process


DEFAULT_AUTHOR_NAME = 'GitHub Actions'
DEFAULT_AUTHOR_EMAIL = 'ryan-williams@users.noreply.github.com'


@group('njsp')
@pass_context
@option('-a', '--configure-author', 'do_configure_author', is_flag=True, help='Set Git user.{name,email} configs: %s / %s' % (DEFAULT_AUTHOR_NAME, DEFAULT_AUTHOR_EMAIL))
@option('-c', '--commit', 'do_commit', count=True, help='1x: commit changes; 2x: commit and push')
def njsp(ctx, do_configure_author, do_commit):
    ctx.obj = dict(
        do_configure_author=do_configure_author,
        do_commit=do_commit,
    )


def step_output(key, value):
    GITHUB_OUTPUT = env.get('GITHUB_OUTPUT')
    if GITHUB_OUTPUT:
        with open(GITHUB_OUTPUT, 'a') as f:
            kv = f'{key}={value}'
            f.write(f'{kv}\n')
            err(f"Step output: {kv}")


def configure_author(name, email):
    process.run('git', 'config', '--global', 'user.name', name)
    process.run('git', 'config', '--global', 'user.email', email)


def command(fn):
    @njsp.command(fn.__name__)
    @pass_context
    @wraps(fn)
    def _fn(ctx, *args, **kwargs):
        do_commit = ctx.obj['do_commit']
        if do_commit:
            repo = Repo()
            if repo.is_dirty():
                raise RuntimeError("Git tree has unstaged changes")

        msg = fn(*args, **kwargs)
        if do_commit:
            if repo.is_dirty():
                do_configure_author = ctx.obj['do_configure_author']
                if do_configure_author:
                    configure_author(
                        env.get('GIT_AUTHOR_NAME', DEFAULT_AUTHOR_NAME),
                        env.get('GIT_AUTHOR_EMAIL', DEFAULT_AUTHOR_EMAIL),
                    )
                process.run('git', 'commit', '-am', msg)
                step_output('sha', repo.commit().hexsha)
                if do_commit > 1:
                    process.run('git', 'push')
            else:
                err("Nothing to commit")

    return _fn
