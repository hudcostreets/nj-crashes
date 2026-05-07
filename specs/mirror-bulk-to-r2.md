# Mirror NJDOT bulk dumps from S3 (DVX cache) to R2 (`raw/` prefix)

> Companion to `specs/raw-file-browser.md`. Run on `e` (or any machine
> with both AWS + CF/R2 creds and the repo's `.dvc` files).

## Goal

Populate `r2://nj-crashes/raw/njdot/data/<year>/...` with the original
NJDOT bulk dump files (`.zip` + `.pqt` + `.txt`) for the file-browser
prototype. Source is the existing DVX S3 cache at
`s3://nj-crashes/.dvc/files/md5/<md5[:2]>/<md5[2:]>` — read each
`.dvc` file in the worktree to get the md5 → S3 key.

## Scope

| Subset | Files | Size |
|--------|------:|-----:|
| **2022 + 2023 only** (recommended for MVP) | 125 | 165 MB |
| All 2001–2023 (if cheap and you want it) | 1,261 | 2.18 GB |

Either is fine — pick by mood. R2 free tier is 10 GB; the full
2.18 GB still fits comfortably alongside `cells/`.

## Source layout

`.dvc` files in the worktree look like:

```yaml
outs:
- md5: b7ebe70b58aece6943e572b443c43c68
  size: 7060495
  hash: md5
  path: NewJersey2022Drivers.zip
```

The blob lives at `s3://nj-crashes/.dvc/files/md5/b7/ebe70b58aece6943e572b443c43c68`.

## Target layout

R2 key mirrors the repo path verbatim, under `raw/`:

```
njdot/data/2022/NewJersey2022Drivers.zip.dvc        ← source .dvc
                                                      ↓
r2://nj-crashes/raw/njdot/data/2022/NewJersey2022Drivers.zip
```

## Implementation (single Python script)

Write `scripts/mirror_bulk_to_r2.py` (executable, `uv run` shebang
with `boto3` + `tqdm` deps). Behavior:

1. CLI args:
   - `--years 2022,2023` (default; comma-separated)
   - `--all` (override; mirror every year)
   - `--include-glob '*.zip,*.pqt,*.txt'` (default; restrict by suffix)
   - `--dry-run` (print plan, do nothing)
   - `--force` (skip the "already exists in R2" check)
   - `--bucket nj-crashes`, `--prefix raw/`
2. Walk `.dvc` files matching the year/include filters. Parse with
   PyYAML.
3. For each:
   - Compute S3 key from md5: `.dvc/files/md5/<md5[:2]>/<md5[2:]>`
   - Compute R2 key: `<prefix><dvc-file-path-without-.dvc-suffix>`
     e.g. `njdot/data/2022/NewJersey2022Drivers.zip.dvc` →
     `raw/njdot/data/2022/NewJersey2022Drivers.zip`
4. Skip if R2 already has the key with matching size (HEAD object,
   compare `ContentLength`). `--force` overrides.
5. Stream S3 → R2 via `get_object`'s `Body` (a `StreamingBody`) passed
   to `put_object`'s `Body=`. **Don't persist to disk.**
6. Progress: `tqdm` over the file count + a running byte total.
7. After: print summary `{n_uploaded, n_skipped, total_bytes,
   elapsed_seconds}`.

### Sketch (not the final script — illustrative)

```python
import boto3, glob, yaml
from pathlib import Path

s3 = boto3.client("s3")  # default profile
r2 = boto3.client(
    "s3", endpoint_url="https://<account>.r2.cloudflarestorage.com",
    aws_access_key_id=..., aws_secret_access_key=..., region_name="auto",
)
BUCKET = "nj-crashes"
PREFIX = "raw/"

for dvc in glob.glob("njdot/data/{2022,2023}/*.dvc"):
    out = yaml.safe_load(open(dvc))["outs"][0]
    md5, path, size = out["md5"], out["path"], out["size"]
    src_key = f".dvc/files/md5/{md5[:2]}/{md5[2:]}"
    dst_key = PREFIX + str(Path(dvc).parent / path)  # strip ".dvc" suffix

    # skip if already mirrored
    try:
        head = r2.head_object(Bucket=BUCKET, Key=dst_key)
        if head["ContentLength"] == size:
            continue
    except r2.exceptions.ClientError:
        pass

    body = s3.get_object(Bucket=BUCKET, Key=src_key)["Body"]
    r2.put_object(Bucket=BUCKET, Key=dst_key, Body=body, ContentLength=size)
```

(Real script reads creds from `~/.aws/credentials` profiles `default`
+ `cf`, parses CLI args, has `--dry-run`, etc.)

## Running on `e`

```bash
ssh e
cd ~/crashes
git pull           # ensure the demo subset's .dvc files are present
spd                # activate venv (per CLAUDE.md)
pip install boto3 pyyaml tqdm   # if not already in deps
python scripts/mirror_bulk_to_r2.py --years 2022,2023 --dry-run
# inspect plan, then:
python scripts/mirror_bulk_to_r2.py --years 2022,2023
```

Expected runtime on `e`'s connection: 165 MB streamed from S3 us-east-1
to R2 via boto3 ≈ a few minutes. Memory peak per file ≤ the largest
zip (~50 MB).

## Verification

After upload, spot-check a few keys:

```bash
AWS_PROFILE=cf aws s3 ls --recursive \
  --endpoint-url=https://<account>.r2.cloudflarestorage.com \
  s3://nj-crashes/raw/njdot/data/2022/ | head

AWS_PROFILE=cf aws s3 cp \
  --endpoint-url=https://<account>.r2.cloudflarestorage.com \
  s3://nj-crashes/raw/njdot/data/2022/NewJersey2022Drivers.zip /tmp/x.zip
unzip -l /tmp/x.zip | head
rm /tmp/x.zip
```

## Cleanup

This script is a one-shot mirror. No state to clean up. The script
itself stays in `scripts/` as documentation + re-runnable in case we
want to expand the subset later (just rerun with `--years 2024,2025`
once those `.dvc` files exist; `--force` to refresh).

## Cost notes

- S3 egress: 165 MB × $0.09/GB ≈ $0.015. (Negligible.)
- R2 storage: 165 MB × $0.015/GB/mo = $0.003/mo.
- R2 egress: free.
- Once the prototype is done, leaving `raw/` in place costs ~$0.04/mo
  for the full 2.18 GB.

## Out of scope

- Adding an `r2` DVX remote. Possible later but adds operational
  surface for a static demo dataset.
- Rewriting paths or transforming files (e.g. unzipping). The browser
  unzips client-side via fflate.
- Mirroring 2024+ data (we don't have it as DVX-tracked bulk yet —
  that's the whole point of asking DOT for it).
