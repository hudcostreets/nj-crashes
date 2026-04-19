from functools import wraps
from importlib import import_module

from click import pass_context, Group
from nj_crashes.paths import ROOT_DIR
from utz import err


# Commands to load lazily: module_name → (command_name, help_text)
LAZY_COMMANDS = {
    'bsky': ('bsky', 'Manage @crashes.hudcostreets.org on Bluesky.'),
    'crash_log': ('crash_log', 'Maintain a history of crash-records adds/updates/deletes.'),
    'export_match_review': ('export_match_review', 'Export NJSP↔NJDOT match-review data as JSON for the frontend UI.'),
    'harmonize_muni_codes': ('harmonize_muni_codes', 'Harmonize county/muni codes between NJDOT and NJSP, output cc2mc2mn.json'),
    'match_njdot': ('match_njdot', 'Multi-pass match NJSP ↔ NJDOT fatal crashes.'),
    'refresh_data': ('refresh_data', 'Snapshot NJSP fatal crash data for the given years.'),
    'refresh_summaries': ('refresh_summaries', 'Update NJSP annual summary PDFs (fetch-summaries.ipynb).'),
    'slack': ('slack', 'Manage automated posts to the #crash-bot channel in HCCS Slack.'),
    'update_cmymc': ('update_cmymc', 'Update county/muni/year/month crash aggregation databases.'),
    'update_pqts': ('update_pqts', 'Update crashes Parquet/SQLite with NJSP crash data, update rundate.json.'),
    'update_projections': ('update_projections', 'Update projected rest-of-year fatalities based on latest NJSP data.'),
    'update_www_data': ('update_www_data', 'Generate CSV data files for frontend plots.'),
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


@pass_context
def _njsp_callback(ctx):
    import os
    ctx.obj = dict(original_cwd=os.getcwd())
    os.chdir(ROOT_DIR)


njsp = LazyGroup(
    'njsp',
    callback=_njsp_callback,
)


def command(fn):
    @njsp.command(fn.__name__)
    @pass_context
    @wraps(fn)
    def _fn(ctx, *args, **kwargs):
        msg = fn(*args, **kwargs)

        # Signal commit message to DVX harness
        try:
            from dvx.stage import stage as dvx_stage
            if dvx_stage.is_dvx_run and msg:
                dvx_stage.commit(msg)
                err(f"DVX commit: {msg}")
        except ImportError:
            pass

    return _fn
