"""`njdot.cells_publish`: content-hashed keys, put-if-absent push, manifest-last
cutover, activate/rollback, and gc (specs/cells-immutable-keys.md)."""
import hashlib
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import pytest
from pyrmts.storage import MemStorage

from njdot import cells_publish as cp

T0 = datetime(2026, 9, 1, tzinfo=timezone.utc)


def md5(b: bytes) -> str:
    return hashlib.md5(b).hexdigest()


def write_build(root: Path, counts: dict[tuple[int, str], int], years=(2001, 2025)) -> Path:
    """A tiny cells build: one raw shard with a `year` column, and one pyramid
    parquet per `(level, shard)` whose content varies with `counts`."""
    raw = root / 'raw' / 's2_l21'
    raw.mkdir(parents=True)
    pq.write_table(pa.table({'year': pa.array(list(years), pa.int16())}), raw / '89d.parquet')
    for (level, shard), n in counts.items():
        d = root / 's2_pyramid' / f's2_l{level}'
        d.mkdir(parents=True, exist_ok=True)
        pq.write_table(pa.table({'cellid': [shard], 'n_crashes': pa.array([n], pa.int32())}), d / f'{shard}.parquet')
    return root


def slot_entry(root: Path, level: int, shard: str) -> dict:
    b = (root / 's2_pyramid' / f's2_l{level}' / f'{shard}.parquet').read_bytes()
    return {'key': f's2_pyramid/s2_l{level}/{shard}.{md5(b)[:12]}.parquet', 'md5': md5(b), 'bytes': len(b)}


class Clock:
    def __init__(self, t: datetime):
        self.t = t

    def __call__(self) -> datetime:
        return self.t


@pytest.fixture
def clock():
    return Clock(T0)


@pytest.fixture
def store(clock):
    return MemStorage(clock=clock)


def build(tmp_path: Path, name: str, counts: dict[tuple[int, str], int]) -> tuple[Path, dict]:
    root = write_build(tmp_path / name, counts)
    return root, cp.build_manifest(root, 21, [4, 5], 4)


def test_build_manifest(tmp_path):
    root, m = build(tmp_path, 'a', {(4, '89b'): 1, (4, '89d'): 2, (5, '89d'): 3})
    body = {k: v for k, v in m.items() if k != 'data_version'}
    assert body == {
        'schema_version': 6,
        'grid': 's2',
        'base_level': 21,
        'shard_level': 4,
        'pyramid_levels': [4, 5],
        'year_range': [2001, 2025],
        'shard_cells': ['89d'],
        'row_counts': {'raw': 2, 's2_l4': 2, 's2_l5': 1},
        'key_template': 's2_pyramid/s2_l{level}/{shard}.{hash:12}.parquet',
        'shards': {
            's2_l4/89b': slot_entry(root, 4, '89b'),
            's2_l4/89d': slot_entry(root, 4, '89d'),
            's2_l5/89d': slot_entry(root, 5, '89d'),
        },
        'd1': {'table_prefix': 'cells_s2_l'},
    }
    assert m['data_version'] == f's2-{md5(cp.dumps(body))[:12]}'
    # Deterministic: same bytes → same manifest (re-push is a no-op).
    assert cp.build_manifest(root, 21, [4, 5], 4) == m


def test_build_manifest_d1_source(tmp_path):
    root, _ = build(tmp_path, 'a', {(4, '89d'): 1})
    (root / 'cells-s2.db').write_bytes(b'sqlite')
    m = cp.build_manifest(root, 21, [4, 5], 4, d1_table_prefix='cells_s2_v2_l')
    assert m['d1'] == {'table_prefix': 'cells_s2_v2_l', 'source_md5': md5(b'sqlite')}
    # The committed md5 wins (the manifest mustn't depend on a local pull).
    (root / 'cells-s2.db.dvc').write_text('outs:\n- md5: b703518dd85c79fcb52ab040aeebb8cc\n  path: cells-s2.db\n')
    assert cp.build_manifest(root, 21, [4, 5], 4)['d1'] == {'table_prefix': 'cells_s2_l', 'source_md5': 'b703518dd85c79fcb52ab040aeebb8cc'}


def test_check_against_dvx(tmp_path):
    root, m = build(tmp_path, 'a', {(4, '89d'): 1, (5, '89d'): 2})
    committed = [
        {'relpath': 's2_l4/89d.parquet', 'md5': m['shards']['s2_l4/89d']['md5']},
        {'relpath': 's2_l5/89d.parquet', 'md5': 'f' * 32},
        {'relpath': 's2_l6/89d.parquet', 'md5': 'e' * 32},
    ]
    assert cp.check_against_dvx(m, committed) == ['s2_l5/89d', 's2_l6/89d']
    assert cp.check_against_dvx(m, committed[:1] + [{'relpath': 's2_l5/89d.parquet', 'md5': m['shards']['s2_l5/89d']['md5']}]) == []


def keys(store: MemStorage) -> list[str]:
    return sorted(k for k, _ in store.list_with_mtime(''))


def test_push_fresh_then_idempotent(tmp_path, store):
    root, m = build(tmp_path, 'a', {(4, '89d'): 1, (5, '89d'): 2})
    shard_keys = sorted(e['key'] for e in m['shards'].values())
    res = cp.push(store, m, root)
    assert (sorted(res.uploaded), res.copied, res.present, res.manifest_written, res.activated) == (shard_keys, [], [], True, True)
    assert keys(store) == sorted([*shard_keys, 'manifest.json', f'manifests/{m["data_version"]}.json'])
    assert store.get('manifest.json') == cp.dumps(m)
    assert store.get(f'manifests/{m["data_version"]}.json') == cp.dumps(m)
    for e in m['shards'].values():
        assert md5(store.get(e['key'])) == e['md5']

    again = cp.push(store, m, root)
    assert (again.uploaded, again.copied, sorted(again.present), again.manifest_written) == ([], [], shard_keys, False)


def test_push_dry_run_writes_nothing(tmp_path, store):
    root, m = build(tmp_path, 'a', {(4, '89d'): 1})
    res = cp.push(store, m, root, dry_run=True)
    assert (res.uploaded, res.present, res.manifest_written, res.activated) == ([m['shards']['s2_l4/89d']['key']], [], True, True)
    assert keys(store) == []


def test_push_copies_from_dvx_remote(tmp_path, store):
    root, m = build(tmp_path, 'a', {(4, '89d'): 1, (5, '89d'): 2})
    l4, l5 = m['shards']['s2_l4/89d'], m['shards']['s2_l5/89d']

    class Dvx:
        blobs = {l4['md5']: (root / 's2_pyramid/s2_l4/89d.parquet').read_bytes()}

        def has(self, h: str) -> bool:
            return h in self.blobs

        def copy(self, h: str, key: str) -> None:
            store.put(key, self.blobs[h])

    dry = cp.push(store, m, root, dvx=Dvx(), dry_run=True)
    assert (dry.copied, dry.uploaded, keys(store)) == ([l4['key']], [l5['key']], [])
    res = cp.push(store, m, root, dvx=Dvx())
    assert (res.copied, res.uploaded) == ([l4['key']], [l5['key']])
    assert md5(store.get(l4['key'])) == l4['md5']


def test_push_staged_then_activate_and_rollback(tmp_path, store):
    root_a, a = build(tmp_path, 'a', {(4, '89d'): 1, (5, '89d'): 2})
    root_b, b = build(tmp_path, 'b', {(4, '89d'): 1, (5, '89d'): 3})
    cp.push(store, a, root_a)
    res = cp.push(store, b, root_b, activate=False)
    # l4 is byte-identical across builds: shared, not re-uploaded.
    assert (res.present, res.uploaded, res.activated) == ([a['shards']['s2_l4/89d']['key']], [b['shards']['s2_l5/89d']['key']], False)
    assert json.loads(store.get('manifest.json'))['data_version'] == a['data_version']

    cp.activate(store, b['data_version'])
    assert store.get('manifest.json') == cp.dumps(b)
    cp.activate(store, a['data_version'])   # rollback
    assert store.get('manifest.json') == cp.dumps(a)


def test_activate_refuses_incomplete_build(tmp_path, store):
    root, m = build(tmp_path, 'a', {(4, '89d'): 1, (5, '89d'): 2})
    cp.push(store, m, root, activate=False)
    store.delete(m['shards']['s2_l5/89d']['key'])
    with pytest.raises(FileNotFoundError, match=r'^1 shard blob\(s\) of s2-[0-9a-f]{12} missing'):
        cp.activate(store, m['data_version'])
    with pytest.raises(FileNotFoundError, match=r'^manifests/s2-nope\.json not found'):
        cp.activate(store, 's2-nope')
    assert store.get('manifest.json') is None


def three_builds(tmp_path, store, clock):
    """Builds a (day 0), b (day 1), c (day 2; active). l4 is shared by all."""
    out = []
    for i, name in enumerate('abc'):
        clock.t = T0 + timedelta(days=i)
        root, m = build(tmp_path, name, {(4, '89d'): 1, (5, '89d'): 10 + i})
        cp.push(store, m, root)
        out.append(m)
    return out


def test_gc_keeps_active_newest_and_young(tmp_path, store, clock):
    a, b, c = three_builds(tmp_path, store, clock)
    before = keys(store)
    clock.t = T0 + timedelta(days=10)
    # Defaults (keep 3, grace 48h): everything is retained.
    plan = cp.gc(store, now=clock.t)
    assert (plan.active, plan.retained, plan.deletions) == (c['data_version'], sorted(m['data_version'] for m in (a, b, c)), [])

    plan = cp.gc(store, keep=2, now=clock.t)
    assert (plan.retained, plan.delete_blobs, plan.delete_manifests, plan.delete_legacy) == (
        sorted([b['data_version'], c['data_version']]),
        [a['shards']['s2_l5/89d']['key']],
        [f'manifests/{a["data_version"]}.json'],
        [],
    )
    assert keys(store) == before   # dry run

    plan = cp.gc(store, keep=1, apply=True, now=clock.t)
    assert (plan.retained, sorted(plan.delete_blobs)) == (
        [c['data_version']],
        sorted([a['shards']['s2_l5/89d']['key'], b['shards']['s2_l5/89d']['key']]),
    )
    assert keys(store) == sorted([
        c['shards']['s2_l4/89d']['key'], c['shards']['s2_l5/89d']['key'],
        'manifest.json', f'manifests/{c["data_version"]}.json',
    ])


def test_gc_grace_protects_recent_pushes(tmp_path, store, clock):
    a, b, c = three_builds(tmp_path, store, clock)
    # 36h after c (48h grace): b (pushed 60h ago) is out of grace, but c is not.
    clock.t = T0 + timedelta(days=2, hours=36)
    plan = cp.gc(store, keep=1, now=clock.t)
    assert (plan.retained, plan.delete_blobs, plan.kept_young) == (
        [c['data_version']],
        sorted([a['shards']['s2_l5/89d']['key'], b['shards']['s2_l5/89d']['key']]),
        [],
    )
    # A stray unreferenced blob written just now is too young to delete.
    store.put('s2_pyramid/s2_l5/89d.0123456789ab.parquet', b'x')
    plan = cp.gc(store, keep=1, now=clock.t)
    assert plan.kept_young == ['s2_pyramid/s2_l5/89d.0123456789ab.parquet']


def test_gc_rollback_target_survives(tmp_path, store, clock):
    a, b, c = three_builds(tmp_path, store, clock)
    cp.activate(store, a['data_version'])   # rollback: a is live again
    clock.t = T0 + timedelta(days=10)
    plan = cp.gc(store, keep=1, now=clock.t)
    # Newest push is c; active is a; only b goes.
    assert (plan.active, plan.retained, plan.delete_blobs) == (
        a['data_version'],
        sorted([a['data_version'], c['data_version']]),
        [b['shards']['s2_l5/89d']['key']],
    )


def test_gc_legacy_layout(tmp_path, store, clock):
    for k in ('s2_pyramid/s2_l5/89d.parquet', 'raw/s2_l21/89d.parquet', 's2-sld.parquet'):
        store.put(k, b'old')
    store.put('manifest.json', json.dumps({'schema_version': 5, 'data_version': 'old'}).encode())
    with pytest.raises(RuntimeError, match=r'^gc: no schema-6 `manifest.json` at this prefix'):
        cp.gc(store, legacy=True)

    builds = three_builds(tmp_path, store, clock)
    clock.t = T0 + timedelta(days=10)
    assert cp.gc(store, now=clock.t).delete_legacy == []
    plan = cp.gc(store, legacy=True, apply=True, now=clock.t)
    assert plan.delete_legacy == ['s2_pyramid/s2_l5/89d.parquet', 'raw/s2_l21/89d.parquet', 's2-sld.parquet']
    assert keys(store) == sorted({
        'manifest.json',
        *(cp.manifest_key(m['data_version']) for m in builds),
        *(e['key'] for m in builds for e in m['shards'].values()),
    })


def test_gc_rereads_before_deleting(tmp_path, store, clock):
    """A build pushed between gc's listing and its deletes (here: a revert to
    a's bytes) re-references a blob the plan marked; it must survive."""
    a, b, c = three_builds(tmp_path, store, clock)
    clock.t = T0 + timedelta(days=10)
    _, d = build(tmp_path, 'd', {(4, '89d'): 1, (5, '89d'): 10})   # a's bytes
    assert d['shards'] == a['shards']
    calls = []
    list_with_mtime = store.list_with_mtime

    def racing_list(prefix):
        if prefix == 'manifests/':
            calls.append(prefix)
            if len(calls) == 2:   # gc's re-read, after planning
                store.put(cp.manifest_key('s2-revert'), cp.dumps({**d, 'data_version': 's2-revert'}))
        return list_with_mtime(prefix)

    store.list_with_mtime = racing_list
    plan = cp.gc(store, keep=1, apply=True, now=clock.t)
    a5, b5 = a['shards']['s2_l5/89d']['key'], b['shards']['s2_l5/89d']['key']
    assert (plan.delete_blobs, plan.kept_repointed) == ([b5], [a5])
    assert (store.head(a5) is None, store.head(b5) is None) == (False, True)
