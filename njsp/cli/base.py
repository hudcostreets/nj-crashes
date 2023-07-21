import click
from git import Repo
from utz import process, env, err


@click.group('njsp')
@click.pass_context
@click.option('-c', '--commit', 'do_commit', multiple=True)
def njsp(ctx, do_commit):
    ctx.obj = { 'do_commit': do_commit }


def step_output(key, value):
    GITHUB_OUTPUT = env.get('GITHUB_OUTPUT')
    if GITHUB_OUTPUT:
        with open(GITHUB_OUTPUT, 'a') as f:
            kv = f'{key}={value}'
            f.write(f'{kv}\n')
            err(f"Step output: {kv}")


def command(fn):
    @njsp.command(fn.__name__)
    @click.pass_context
    def _fn(ctx, *args, **kwargs):
        do_commit = ctx.obj['do_commit']
        if do_commit:
            repo = Repo()
            if repo.is_dirty():
                raise RuntimeError("Git tree has unstaged changes")

        msg = fn(*args, **kwargs)
        if do_commit:
            if repo.is_dirty():
                process.run('git', 'commit', '-am', msg)
                step_output('sha', repo.commit().hexsha)
                if do_commit > 1:
                    process.run('git', 'push')
            else:
                err("Nothing to commit")

    return _fn
