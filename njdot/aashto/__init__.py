"""AASHTO Crash.csv ingestion pipeline.

Subcommands exposed via `njdot aashto`:
  - `schema`     — AASHTO crashes → NJDOT-schema combined parquet
  - `persons`    — AASHTO persons → DOTr-style occupants + pedestrians supplements
  - `supplement` — combine AASHTO + NJSP-only fatals + per-crash VTC matrix

The lower-level `normalize.py` (Crash.csv → AASHTO per-table parquets) is
still a `uv run --script` entrypoint since it only runs locally after a
manual `Crash.csv` download.
"""
import click


@click.group('aashto')
def aashto():
    """Tools for AASHTO Crash.csv pipeline."""
    pass


from njdot.aashto.to_njdot_schema import schema
from njdot.aashto.to_njdot_persons import persons
from njdot.aashto.supplement_with_sp import supplement

aashto.add_command(schema)
aashto.add_command(persons)
aashto.add_command(supplement)
