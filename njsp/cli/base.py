from functools import wraps
from importlib import import_module

from click import pass_context, Group, option
from git import Repo
from utz import process, env, err


DEFAULT_AUTHOR_NAME = 'GitHub Actions'
DEFAULT_AUTHOR_EMAIL = 'ryan-williams@users.noreply.github.com'


# Commands to load lazily: module_name → (command_name, help_text)
LAZY_COMMANDS = {
    'bsky': ('bsky', 'Manage @crashes.hudcostreets.org on Bluesky.'),
    'crash_log': ('crash_log', 'Maintain a history of crash-records adds/updates/deletes.'),
    'harmonize_muni_codes': ('harmonize_muni_codes', 'Harmonize county/muni codes between NJDOT and NJSP, output cc2mc2mn.json'),
    'refresh_data': ('refresh_data', 'Snapshot NJSP fatal crash data for the given years.'),
    'refresh_summaries': ('refresh_summaries', 'Update NJSP annual summary PDFs (fetch-summaries.ipynb).'),
    'slack': ('slack', 'Manage automated posts to the #crash-bot channel in HCCS Slack.'),
    'update_cmymc': ('update_cmymc', 'Update county/muni/year/month crash aggregation databases.'),
    'update_plots': ('update_plots', 'Regenerate plots based on latest NJSP data.'),
    'update_pqts': ('update_pqts', 'Update crashes Parquet/SQLite with NJSP crash data, update rundate.json.'),
    'update_projections': ('update_projections', 'Update projected rest-of-year fatalities based on latest NJSP data.'),
}


class LazyGroup(Group):
    """Click Group that lazily imports commands only when invoked."""

    def list_commands(self, ctx):
        return sorted(cmd_name for cmd_name, _ in LAZY_COMMANDS.values())

    def get_command(self, ctx, cmd_name):
        # Check if already loaded
        if cmd_name in self.commands:
            return self.commands[cmd_name]

        # Find the module for this command
        module_name = None
        for mod, (cmd, _) in LAZY_COMMANDS.items():
            if cmd == cmd_name:
                module_name = mod
                break

        if module_name is None:
            return None

        # Import the module (this triggers the @command decorator registration)
        import_module(f'njsp.cli.{module_name}')

        # Now the command should be registered
        return self.commands.get(cmd_name)

    def format_commands(self, ctx, formatter):
        """Override to show help text without importing modules."""
        commands = []
        for cmd_name, help_text in sorted(LAZY_COMMANDS.values()):
            commands.append((cmd_name, help_text))

        if commands:
            # Calculate max width for alignment
            limit = formatter.width - 6 - max(len(cmd) for cmd, _ in commands)
            rows = []
            for cmd_name, help_text in commands:
                # Truncate help text if needed
                if len(help_text) > limit:
                    help_text = help_text[:limit - 3] + '...'
                rows.append((cmd_name, help_text))

            with formatter.section('Commands'):
                formatter.write_dl(rows)


# Create the group using decorators, then swap the class
@pass_context
@option('-a', '--configure-author', 'do_configure_author', is_flag=True, help='Set Git user.{name,email} configs: %s / %s' % (DEFAULT_AUTHOR_NAME, DEFAULT_AUTHOR_EMAIL))
@option('-c', '--commit', 'do_commit', count=True, help='1x: commit changes; 2x: commit and push')
def _njsp_callback(ctx, do_configure_author, do_commit):
    ctx.obj = dict(
        do_configure_author=do_configure_author,
        do_commit=do_commit,
    )


# Create LazyGroup with the decorated callback's params
njsp = LazyGroup(
    'njsp',
    callback=_njsp_callback,
    params=_njsp_callback.__click_params__,
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
