# Adopt `/repo-root` shorthand in `.dvc` dep paths

## Context

DVX resolves `.dvc` dep paths written with a leading `/` as repo-root-absolute
(see `~/c/dvx/src/dvx/run/dvc_files.py` `_resolve_dep_paths`). The shorthand
is already used in `api/d1-import.dvc`.

`_relativize_dep_paths` (the write-side inverse) uses `os.path.relpath` and
produces `../../`-laden strings, so hand-edited `/`-shorthand deps revert to
`../../` on the next `dvx run` that touches the file.

The DVX spec `~/c/dvx/specs/dep-path-shorthand.md` proposes making
`_relativize_dep_paths` prefer the `/` shorthand for any dep that would
otherwise need `..` segments.

## Decision

- Hand-convert all 5 `.dvc` files in this repo that currently have `../`
  dep paths to the `/repo-root` form. Reads stay valid.
- Once the DVX change ships, the rewrites will preserve the shorthand
  (instead of reverting to `../../`).
- In the interim, expect some of these files to drift back to `../../`
  form if DVX rewrites them before the DVX change lands. Re-convert as
  needed.

## Converted files

- `njsp/data/update_pqts.dvc` (git_deps: `../../data/FAUQStats{2024,2025,2026}.xml`)
- `www/dist/njsp/csvs.dvc` (deps: `../../../njsp/data/crashes.parquet`)
- `www/dist/njsp/projections.dvc` (deps: `../../../njsp/data/crashes.parquet`)
- `www/public/njsp/csvs.dvc` (deps: `../../../njsp/data/crashes.parquet`)
- `www/public/njsp/projections.dvc` (deps: `../../../njsp/data/crashes.parquet`)

Every other `.dvc` file in the repo has only same-directory deps (no `../`
segments), so the shorthand doesn't apply.
