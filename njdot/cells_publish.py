"""Immutable, content-hashed publication of the cells pyramid to R2
(`specs/cells-immutable-keys.md`).

Layout under the cells root prefix (`CELLS_PREFIX`, default `cells`):

    s2_pyramid/s2_l{level}/{shard}.{hash:12}.parquet   # immutable shard blobs
    manifests/{data_version}.json                      # immutable, one per build
    manifest.json                                      # the one mutable object: the active build

Local build outputs keep their fixed names (`data/cells/s2_pyramid/s2_l{L}/{shard}.parquet`,
DVX-tracked); the hash only exists in R2 keys and in the manifest, which is the
registry the worker reads keys from.

Write protocol (`pyrmts.keys.put_shard`): derive each key from the shard's md5,
`put` only if absent (identical bytes by construction, so re-pushing a build
uploads nothing), never overwrite. When the DVX remote already holds the blob
(`.dvc/files/md5/xx/yyyy`, same bucket), the "upload" is a server-side copy.
Then write `manifests/{data_version}.json` (put-if-absent), and last,
`manifest.json` — the atomic cutover. Nothing is deleted inline; `gc` removes
blobs no retained manifest references, after a grace period.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable, Protocol

import pyarrow.parquet as pq

from nj_crashes.utils.log import err

SCHEMA_VERSION = 6
#: Shard key template (pyrmts `keyTemplate` grammar: `{hash:12}` = first 12
#: hex chars of the payload md5). The hash only needs to be unique among
#: versions of one `(level, shard)` slot, so 12 is plenty.
PYRAMID_KEY_TEMPLATE = 's2_pyramid/s2_l{level}/{shard}.{hash:12}.parquet'
MANIFEST_KEY = 'manifest.json'
MANIFESTS_DIR = 'manifests'
D1_TABLE_PREFIX_DEFAULT = 'cells_s2_l'
DVX_BLOB_ROOT = '.dvc/files/md5'
GC_GRACE_DEFAULT = timedelta(hours=48)
GC_KEEP_DEFAULT = 3


class Storage(Protocol):
    """The subset of `pyrmts.storage` (`MemStorage` / `S3Storage`) used here;
    keys are relative to the cells root prefix."""
    def head(self, key: str) -> dict | None: ...
    def get(self, key: str) -> bytes | None: ...
    def put(self, key: str, data: bytes) -> None: ...
    def delete(self, key: str) -> None: ...
    def list_with_mtime(self, prefix: str) -> Iterable[tuple[str, datetime | None]]: ...


def dvx_blob_key(md5: str) -> str:
    """Bucket key of a file's blob in the DVX (DVC 3) remote: `files/md5/ab/cdef…`."""
    return f'{DVX_BLOB_ROOT}/{md5[:2]}/{md5[2:]}'


def slot_id(level: int, shard: str) -> str:
    """A pyramid slot's id in the manifest's `shards` map (its local relpath
    under `s2_pyramid/`, minus the extension)."""
    return f's2_l{level}/{shard}'


def manifest_key(data_version: str) -> str:
    return f'{MANIFESTS_DIR}/{data_version}.json'


def dumps(manifest: dict) -> bytes:
    """Canonical manifest bytes (the same build always serializes identically)."""
    return (json.dumps(manifest, indent=2, sort_keys=True) + '\n').encode()


def local_pyramid_files(out_dir: Path, levels: Iterable[int]) -> list[tuple[int, str, Path]]:
    """`(level, shard, path)` for every on-disk pyramid shard, sorted."""
    out = []
    for level in sorted(levels):
        pdir = out_dir / 's2_pyramid' / f's2_l{level}'
        for p in sorted(pdir.glob('*.parquet')) if pdir.exists() else []:
            out.append((level, p.stem, p))
    return out


def build_manifest(
    out_dir: Path,
    base_level: int,
    levels: Iterable[int],
    shard_level: int,
    d1_table_prefix: str = D1_TABLE_PREFIX_DEFAULT,
) -> dict:
    """Walk the local build and return its (deterministic) manifest.

    `shards` maps each slot to its content-hashed key (relative to the cells
    root prefix), md5 and size: the registry the worker resolves reads through.
    `data_version` is derived from everything else in the manifest, so the
    same build always yields the same manifest bytes and key (re-pushing is a
    no-op, and doesn't bust the worker's edge cache)."""
    from pyrmts.keys import content_hash, substitute_key

    raw_dir = out_dir / 'raw' / f's2_l{base_level}'
    raw_paths = sorted(raw_dir.glob('*.parquet'))
    if not raw_paths:
        raise FileNotFoundError(f'No raw shards in {raw_dir}; run `compute cells raw` first')
    row_counts: dict[str, int] = {}
    years: set[int] = set()
    raw_total = 0
    for p in raw_paths:
        f = pq.ParquetFile(p)
        raw_total += f.metadata.num_rows
        idx = f.schema_arrow.get_field_index('year')
        if idx < 0:
            continue
        for rg in range(f.metadata.num_row_groups):
            stats = f.metadata.row_group(rg).column(idx).statistics
            if stats is not None and stats.has_min_max:
                years.update((int(stats.min), int(stats.max)))
    row_counts['raw'] = raw_total

    shards: dict[str, dict] = {}
    built_levels: list[int] = []
    for level, shard, path in local_pyramid_files(out_dir, levels):
        data = path.read_bytes()
        md5 = content_hash(data)
        key = substitute_key(PYRAMID_KEY_TEMPLATE, {'level': level, 'shard': shard, 'hash': md5})
        shards[slot_id(level, shard)] = {'key': key, 'md5': md5, 'bytes': len(data)}
        if level not in built_levels:
            built_levels.append(level)
        row_counts[f's2_l{level}'] = row_counts.get(f's2_l{level}', 0) + pq.ParquetFile(path).metadata.num_rows

    # The D1 rollup's source, as committed (`cells-s2.db.dvc`) so the
    # manifest doesn't depend on whether the 0.5 GB .db is pulled locally;
    # the local file's md5 only when there is no `.dvc` (fixtures).
    d1: dict = {'table_prefix': d1_table_prefix}
    db, db_dvc = out_dir / 'cells-s2.db', out_dir / 'cells-s2.db.dvc'
    if db_dvc.exists():
        import yaml
        d1['source_md5'] = yaml.safe_load(db_dvc.read_text())['outs'][0]['md5']
    elif db.exists():
        d1['source_md5'] = content_hash(db.read_bytes())

    body = {
        'schema_version': SCHEMA_VERSION,
        'grid': 's2',
        'base_level': base_level,
        'shard_level': shard_level,
        'pyramid_levels': built_levels,
        'year_range': [min(years), max(years)] if years else None,
        'shard_cells': sorted(p.stem for p in raw_paths),
        'row_counts': row_counts,
        'key_template': PYRAMID_KEY_TEMPLATE,
        'shards': shards,
        'd1': d1,
    }
    data_version = f's2-{content_hash(dumps(body))[:12]}'
    return {'data_version': data_version, **body}


def check_against_dvx(manifest: dict, dir_entries: list[dict]) -> list[str]:
    """Slots whose md5 differs from the committed DVX `.dir` listing of
    `s2_pyramid` (entries `{"relpath": "s2_l21/89d.parquet", "md5": …}`), plus
    slots missing from either side: promoting such a build would serve bytes
    no commit records."""
    committed = {e['relpath'].removesuffix('.parquet'): e['md5'] for e in dir_entries}
    local = {s: v['md5'] for s, v in manifest['shards'].items()}
    return sorted(s for s in committed.keys() | local.keys() if committed.get(s) != local.get(s))


class DvxBlobs(Protocol):
    """The DVX remote's content-addressed blobs (same bucket, `.dvc/files/md5/…`)."""
    def has(self, md5: str) -> bool: ...
    def copy(self, md5: str, key: str) -> None:
        """Server-side copy of the blob to `key` (relative to the cells root)."""


class DvxCopyStorage:
    """Storage wrapper whose `put` server-side-copies the DVX remote's blob
    for the same bytes when it has one, and only uploads otherwise. Everything
    else delegates."""

    def __init__(self, inner: Storage, dvx: DvxBlobs | None) -> None:
        self.inner = inner
        self.dvx = dvx
        self.copied: list[str] = []
        self.uploaded: list[str] = []

    def head(self, key: str) -> dict | None:
        return self.inner.head(key)

    def get(self, key: str) -> bytes | None:
        return self.inner.get(key)

    def put(self, key: str, data: bytes) -> None:
        from pyrmts.keys import content_hash
        md5 = content_hash(data)
        if self.dvx is not None and self.dvx.has(md5):
            self.dvx.copy(md5, key)
            self.copied.append(key)
            return
        self.inner.put(key, data)
        self.uploaded.append(key)

    def delete(self, key: str) -> None:
        self.inner.delete(key)

    def list_with_mtime(self, prefix: str):
        return self.inner.list_with_mtime(prefix)


@dataclass
class PushResult:
    data_version: str
    uploaded: list[str] = field(default_factory=list)
    copied: list[str] = field(default_factory=list)
    present: list[str] = field(default_factory=list)
    manifest_written: bool = False
    activated: bool = False


def push(
    storage: Storage,
    manifest: dict,
    out_dir: Path,
    *,
    activate: bool = True,
    dvx: DvxBlobs | None = None,
    dry_run: bool = False,
) -> PushResult:
    """Publish a build: shard blobs (put-if-absent), then its immutable
    `manifests/{data_version}.json`, then (if `activate`) `manifest.json`.
    Dry run: the same classification (present / copy / upload), no writes."""
    from pyrmts.keys import put_shard

    res = PushResult(data_version=manifest['data_version'])
    store = DvxCopyStorage(storage, dvx)
    for slot, entry in sorted(manifest['shards'].items()):
        if dry_run:
            if storage.head(entry['key']) is not None:
                res.present.append(entry['key'])
            elif dvx is not None and dvx.has(entry['md5']):
                res.copied.append(entry['key'])
            else:
                res.uploaded.append(entry['key'])
            continue
        level_s, shard = slot.split('/')
        values = {'level': int(level_s.removeprefix('s2_l')), 'shard': shard}
        # `put_shard` HEADs first: an existing key is identical bytes by
        # construction (it verifies an md5 etag against the payload when R2
        # returns one), so nothing is uploaded or overwritten.
        w = put_shard(store, PYRAMID_KEY_TEMPLATE, values, _read(out_dir, slot))
        if w.key != entry['key'] or w.md5 != entry['md5']:
            raise RuntimeError(f'{slot}: local bytes changed since the manifest was built ({w.key} != {entry["key"]})')
        if not w.put:
            res.present.append(w.key)
    if not dry_run:
        res.uploaded = list(store.uploaded)
        res.copied = list(store.copied)

    mkey = manifest_key(manifest['data_version'])
    body = dumps(manifest)
    existing = storage.get(mkey)
    if existing is None:
        if not dry_run:
            storage.put(mkey, body)
        res.manifest_written = True
    elif existing != body:
        raise RuntimeError(f'{mkey} exists with different content (manifest serialization is not deterministic?)')
    if activate:
        if not dry_run:
            storage.put(MANIFEST_KEY, body)
        res.activated = True
    return res


def r2_storage(bucket: str, prefix: str) -> Storage:
    """`pyrmts.storage.S3Storage` rooted at `s3://{bucket}/{prefix}/` (creds +
    endpoint from the env, e.g. via `infra/r2-run`)."""
    from pyrmts.storage import S3Storage
    return S3Storage(bucket, prefix=prefix)


class R2DvxBlobs:
    """`DvxBlobs` over the DVX remote in the same R2 bucket
    (`s3://{bucket}/.dvc/files/md5/…`): `copy` is an S3 CopyObject, so the
    bytes never leave R2."""

    def __init__(self, bucket: str, prefix: str) -> None:
        import boto3
        self.bucket = bucket
        self.prefix = prefix
        self.client = boto3.client('s3')

    def has(self, md5: str) -> bool:
        from botocore.exceptions import ClientError
        src = dvx_blob_key(md5)
        try:
            head = self.client.head_object(Bucket=self.bucket, Key=src)
        except ClientError as e:
            if e.response['Error']['Code'] in ('404', 'NoSuchKey', 'NotFound'):
                return False
            raise
        etag = head.get('ETag', '').strip('"')
        if '-' not in etag and etag != md5:
            raise RuntimeError(f'DVX blob {src} has etag {etag}, expected {md5}')
        return True

    def copy(self, md5: str, key: str) -> None:
        self.client.copy_object(
            Bucket=self.bucket, Key=f'{self.prefix}/{key}',
            CopySource={'Bucket': self.bucket, 'Key': dvx_blob_key(md5)},
        )


def _read(out_dir: Path, slot: str) -> bytes:
    return (out_dir / 's2_pyramid' / f'{slot}.parquet').read_bytes()


def read_manifest(storage: Storage, key: str) -> dict | None:
    data = storage.get(key)
    return None if data is None else json.loads(data)


def activate(storage: Storage, data_version: str, *, dry_run: bool = False) -> dict:
    """Point `manifest.json` at an already-pushed build (cutover or rollback).
    Refuses when the build's manifest or any of its shard blobs is missing."""
    manifest = read_manifest(storage, manifest_key(data_version))
    if manifest is None:
        raise FileNotFoundError(f'{manifest_key(data_version)} not found; push the build first')
    missing = sorted(e['key'] for e in manifest['shards'].values() if storage.head(e['key']) is None)
    if missing:
        raise FileNotFoundError(f'{len(missing)} shard blob(s) of {data_version} missing (e.g. {missing[0]}); re-push it')
    if not dry_run:
        storage.put(MANIFEST_KEY, dumps(manifest))
    return manifest


@dataclass
class GcPlan:
    active: str
    retained: list[str]
    delete_blobs: list[str] = field(default_factory=list)
    delete_manifests: list[str] = field(default_factory=list)
    delete_legacy: list[str] = field(default_factory=list)
    kept_young: list[str] = field(default_factory=list)
    kept_repointed: list[str] = field(default_factory=list)

    @property
    def deletions(self) -> list[str]:
        return [*self.delete_blobs, *self.delete_manifests, *self.delete_legacy]


def _referenced(storage: Storage, versions: Iterable[str]) -> set[str]:
    keys: set[str] = set()
    for v in versions:
        m = read_manifest(storage, manifest_key(v))
        if m is None:
            raise FileNotFoundError(f'{manifest_key(v)} vanished during gc')
        keys.update(e['key'] for e in m['shards'].values())
    return keys


def gc(
    storage: Storage,
    *,
    grace: timedelta = GC_GRACE_DEFAULT,
    keep: int = GC_KEEP_DEFAULT,
    legacy: bool = False,
    apply: bool = False,
    now: datetime | None = None,
) -> GcPlan:
    """Delete (dry-run by default) what no retained manifest references.

    Retained builds: the active one (`manifest.json`), the newest `keep`
    pushed manifests, and any pushed within `grace` (rollback targets, and
    in-flight reads / cached responses of a just-replaced build). A blob is a
    candidate when it has the hashed key shape (`pyrmts.keys.slot_of`),
    no retained manifest references it, and it is older than `grace`; blobs
    without an mtime are never deleted. Before deleting, the retained set is
    re-read, so a build activated or pushed since the listing keeps its blobs
    (mirrors `pyrmts_engine.gc.gc_orphans`). `legacy=True` also removes the
    pre-hash fixed-name layout (`s2_pyramid/s2_l{L}/{shard}.parquet`, `raw/`,
    `s2-sld.parquet`) left by the old `aws s3 sync` push."""
    from pyrmts.keys import legacy_template, parse_key, slot_of

    now = now or datetime.now(timezone.utc)
    active_m = read_manifest(storage, MANIFEST_KEY)
    if active_m is None or 'shards' not in active_m:
        raise RuntimeError(
            f'gc: no schema-{SCHEMA_VERSION} `{MANIFEST_KEY}` at this prefix (missing, or a legacy fixed-name build); '
            'refusing — every hashed blob would look orphaned'
        )
    active = active_m['data_version']

    def retained_versions() -> tuple[list[str], list[tuple[str, datetime | None]]]:
        listed = []
        for key, mtime in storage.list_with_mtime(f'{MANIFESTS_DIR}/'):
            if key.endswith('.json'):
                listed.append((key[len(MANIFESTS_DIR) + 1:-len('.json')], mtime))
        epoch = datetime.min.replace(tzinfo=timezone.utc)
        newest = sorted(listed, key=lambda vm: vm[1] or epoch, reverse=True)
        keep_set = {active}
        keep_set.update(v for v, _ in newest[:keep])
        keep_set.update(v for v, m in listed if m is None or now - m < grace)
        return sorted(keep_set), listed

    retained, listed = retained_versions()
    plan = GcPlan(active=active, retained=retained)
    referenced = _referenced(storage, retained)
    legacy_tmpl = legacy_template(PYRAMID_KEY_TEMPLATE)

    for key, mtime in storage.list_with_mtime('s2_pyramid/'):
        if key in referenced:
            continue
        if slot_of(PYRAMID_KEY_TEMPLATE, key) is None:
            if legacy and legacy_tmpl is not None and parse_key(legacy_tmpl, key) is not None:
                plan.delete_legacy.append(key)
            continue
        if mtime is None or now - mtime < grace:
            plan.kept_young.append(key)
            continue
        plan.delete_blobs.append(key)
    for v, mtime in listed:
        if v not in retained and mtime is not None and now - mtime >= grace:
            plan.delete_manifests.append(manifest_key(v))
    if legacy:
        for prefix in ('raw/', 's2-sld.parquet'):
            plan.delete_legacy.extend(k for k, _ in storage.list_with_mtime(prefix))

    if apply and plan.deletions:
        fresh_retained, _ = retained_versions()
        fresh = _referenced(storage, fresh_retained)
        dropped = [k for k in plan.delete_blobs if k in fresh]
        plan.kept_repointed = dropped
        plan.delete_blobs = [k for k in plan.delete_blobs if k not in fresh]
        plan.delete_manifests = [k for k in plan.delete_manifests if k[len(MANIFESTS_DIR) + 1:-len('.json')] not in fresh_retained]
        for key in plan.deletions:
            storage.delete(key)
    return plan


def summarize_gc(plan: GcPlan, apply: bool) -> None:
    verb = 'deleted' if apply else 'would delete'
    err(f'gc: active {plan.active}; retained {len(plan.retained)} build(s): {", ".join(plan.retained)}')
    err(
        f'gc: {verb} {len(plan.delete_blobs)} orphan blob(s), {len(plan.delete_manifests)} manifest(s), '
        f'{len(plan.delete_legacy)} legacy object(s); kept {len(plan.kept_young)} inside the grace period'
        + (f', {len(plan.kept_repointed)} re-referenced since the listing' if plan.kept_repointed else '')
    )
