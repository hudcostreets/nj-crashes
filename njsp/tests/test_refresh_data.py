"""Unit tests for `njsp.cli.refresh_data` (`.dvc` rendering, fetch-log records).

Guards the code path that keeps `data/FAUQStats*.xml.dvc` in sync with
each daily fetch's response headers (ETag, Last-Modified). A regression
here would desync the `.dvc` deps section from the git-tracked XML,
breaking `dvx update` as a fallback fetcher.
"""
import hashlib
import json
import os
from datetime import date
from pathlib import Path
from unittest.mock import patch

import pytest
import yaml

from njsp.cli.refresh_data import is_rollback, rundate_dt, update_xml_dvc


class _FakeResponse:
    """Minimal stand-in for `requests.Response` (only `.headers` is read)."""
    def __init__(self, headers):
        self.headers = headers


def _write_dvc(path: Path, data: dict) -> None:
    path.write_text(yaml.safe_dump(data, sort_keys=False))


@pytest.fixture(autouse=True)
def _no_git_add():
    """Tests operate on temp files outside the repo; skip the `git add`
    that `update_xml_dvc` would otherwise call."""
    with patch('njsp.cli.refresh_data.process.run'):
        yield


def test_update_xml_dvc_writes_outs_only_when_no_response(tmp_path):
    """Without a `response`, only `outs[0].md5` + `outs[0].size` update."""
    xml = tmp_path / 'FAUQStats2026.xml'
    xml.write_bytes(b'<HELLO/>')
    dvc = tmp_path / 'FAUQStats2026.xml.dvc'
    _write_dvc(dvc, {
        'deps': [{'path': 'https://example.com/FAUQStats2026.xml'}],
        'outs': [{'md5': 'stale', 'size': 0, 'hash': 'md5', 'path': 'FAUQStats2026.xml'}],
        'meta': {'git_tracked': True},
    })

    update_xml_dvc(str(xml), b'<HELLO/>')

    data = yaml.safe_load(dvc.read_text())
    assert data['outs'][0]['md5'] == '3979cf84e97c13fb71dda092c9e22d0c'
    assert data['outs'][0]['size'] == 8
    # deps untouched (no `response`)
    assert 'checksum' not in data['deps'][0]
    assert 'mtime' not in data['deps'][0]


def test_update_xml_dvc_writes_deps_from_response(tmp_path):
    """With a `response`, `deps[0]` also gets checksum/size/mtime and
    `meta.import.fetched` is stamped."""
    xml = tmp_path / 'FAUQStats2026.xml'
    content = b'<HELLO/>'
    xml.write_bytes(content)
    dvc = tmp_path / 'FAUQStats2026.xml.dvc'
    _write_dvc(dvc, {
        'deps': [{'path': 'https://example.com/FAUQStats2026.xml'}],
        'outs': [{'md5': 'stale', 'size': 0, 'hash': 'md5', 'path': 'FAUQStats2026.xml'}],
        'meta': {'git_tracked': True},
    })

    resp = _FakeResponse({
        'ETag': '"abc123-def456"',
        'Last-Modified': 'Tue, 14 Apr 2026 15:20:07 GMT',
    })
    update_xml_dvc(str(xml), content, response=resp)

    data = yaml.safe_load(dvc.read_text())
    dep = data['deps'][0]
    assert dep['checksum'] == '"abc123-def456"'
    assert dep['size'] == len(content)
    assert dep['mtime'] == '2026-04-14T15:20:07+00:00'
    assert data['outs'][0]['md5'] == '3979cf84e97c13fb71dda092c9e22d0c'
    assert data['meta']['import']['fetched']  # today's date, just check set


def test_update_xml_dvc_handles_missing_headers(tmp_path):
    """If response lacks ETag / Last-Modified, corresponding fields stay
    untouched (not written as None)."""
    xml = tmp_path / 'FAUQStats2026.xml'
    content = b'<HELLO/>'
    xml.write_bytes(content)
    dvc = tmp_path / 'FAUQStats2026.xml.dvc'
    _write_dvc(dvc, {
        'deps': [{'path': 'https://example.com/FAUQStats2026.xml'}],
        'outs': [{'md5': 'stale', 'size': 0, 'hash': 'md5', 'path': 'FAUQStats2026.xml'}],
        'meta': {'git_tracked': True},
    })

    resp = _FakeResponse({})  # no relevant headers
    update_xml_dvc(str(xml), content, response=resp)

    data = yaml.safe_load(dvc.read_text())
    dep = data['deps'][0]
    assert 'checksum' not in dep
    assert 'mtime' not in dep
    # size still gets written (we know it from len(content), not the header)
    assert dep['size'] == len(content)


def test_update_xml_dvc_preserves_user_agent(tmp_path):
    """`deps[0].user_agent` (set once by `dvx import-url --git`) stays
    across subsequent daily refreshes."""
    xml = tmp_path / 'FAUQStats2026.xml'
    content = b'<HELLO/>'
    xml.write_bytes(content)
    dvc = tmp_path / 'FAUQStats2026.xml.dvc'
    ua = 'Mozilla/5.0 Test UA'
    _write_dvc(dvc, {
        'deps': [{'path': 'https://example.com/FAUQStats2026.xml', 'user_agent': ua}],
        'outs': [{'md5': 'stale', 'size': 0, 'hash': 'md5', 'path': 'FAUQStats2026.xml'}],
        'meta': {'git_tracked': True},
    })

    resp = _FakeResponse({'ETag': '"x"', 'Last-Modified': 'Tue, 14 Apr 2026 15:20:07 GMT'})
    update_xml_dvc(str(xml), content, response=resp)

    data = yaml.safe_load(dvc.read_text())
    assert data['deps'][0]['user_agent'] == ua


# ── `render_xml_dvc` goldens, shared with the `njsp-snapshot` Worker's TS port ──

UA_LINE = (
    '  user_agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML,\n'
    '    like Gecko) Chrome/120.0.0.0 Safari/537.36\n'
)
URL = 'https://njsp.njoag.gov/wp/wp-content/plugins/fatal-crash-data/xml/FAUQStats2026.xml'
# `data/FAUQStats2026.xml.dvc` as of 2026-10-31 (current shape: imported via `dvx import-url --git`).
DVC_FULL = (
    'deps:\n'
    f'- path: {URL}\n'
    "  checksum: '\"2f375-65f239beeffed\"'\n"
    '  size: 193397\n'
    "  mtime: '2026-10-31T14:20:04+00:00'\n"
    f'{UA_LINE}'
    'outs:\n'
    '- md5: aedd16377beb2b1a8a766809c8951415\n'
    '  size: 193397\n'
    '  hash: md5\n'
    '  path: FAUQStats2026.xml\n'
    'meta:\n'
    '  git_tracked: true\n'
    '  import:\n'
    "    fetched: '2026-10-31'\n"
)
# Older-year shape (`data/FAUQStats2008.xml.dvc`): no deps details, no `meta.import`.
DVC_BARE = (
    'deps:\n'
    f'- path: {URL}\n'
    'outs:\n'
    '- md5: 017b63c673518b66eff6dcabf5af4778\n'
    '  size: 198875\n'
    '  hash: md5\n'
    '  path: FAUQStats2026.xml\n'
    'meta:\n'
    '  git_tracked: true\n'
)
XML = '<FAUQSTATS>\n  <RUNDATE>Sun Nov 01 10:00:04 EST 2026</RUNDATE>\n</FAUQSTATS>\n'
LM = 'Sun, 01 Nov 2026 15:20:05 GMT'
# name → (dvc, content, headers, fetched)
GOLDEN_CASES = {
    'full': (DVC_FULL, XML, {'ETag': '"2f4a1-65f3a0c1d2e3f"', 'Last-Modified': LM}, '2026-11-01'),
    'full-weak-etag': (DVC_FULL, XML, {'ETag': 'W/"2f4a1-65f3a0c1d2e3f"', 'Last-Modified': LM}, '2026-11-01'),
    'full-etag-only': (DVC_FULL, XML, {'ETag': '"abc"'}, '2026-11-01'),
    'full-lm-only': (DVC_FULL, XML, {'Last-Modified': 'Mon, 02 Nov 2026 09:05:00 GMT'}, '2026-11-02'),
    'full-no-headers': (DVC_FULL, XML, {}, '2026-11-01'),
    'full-no-response': (DVC_FULL, XML, None, '2026-11-01'),
    'bare': (DVC_BARE, XML, {'ETag': '"4bc21-65f239bead584"', 'Last-Modified': LM}, '2026-11-01'),
    'bare-no-response': (DVC_BARE, XML, None, '2026-11-01'),
    'bare-unquoted-etag': (DVC_BARE, XML, {'ETag': 'abc-123', 'Last-Modified': LM}, '2026-11-01'),
    'bare-numeric-etag': (DVC_BARE, XML, {'ETag': '12345', 'Last-Modified': LM}, '2026-11-01'),
}
GOLDEN_PATH = Path(__file__).parents[2] / 'njsp-snapshot' / 'test' / 'fixtures' / 'dvc-golden.json'


def _golden_cases() -> list[dict]:
    from njsp.cli.refresh_data import render_xml_dvc
    out = []
    for name, (dvc, content, headers, fetched) in GOLDEN_CASES.items():
        out.append({
            'name': name,
            'dvc': dvc,
            'content': content,
            'headers': headers,
            'fetched': fetched,
            'expected': render_xml_dvc(dvc, content.encode(), headers, date.fromisoformat(fetched)),
        })
    return out


def test_snapshot_worker_goldens():
    """`njsp-snapshot/test/fixtures/dvc-golden.json` == what `render_xml_dvc` writes.

    The Worker's vitest suite asserts its TS renderer reproduces each
    `expected` byte-for-byte; this side pins the goldens to the Python
    writer. Regenerate with `UPDATE_GOLDEN=1 pytest njsp/tests/test_refresh_data.py`.
    """
    actual = json.dumps(_golden_cases(), indent=2) + '\n'
    if os.environ.get('UPDATE_GOLDEN'):
        GOLDEN_PATH.write_text(actual)
    assert GOLDEN_PATH.read_text() == actual


def test_committed_xml_dvcs_are_pyyaml_canonical():
    """Every committed `data/FAUQStats*.xml.dvc` round-trips through PyYAML
    unchanged — the precondition for the Worker's line-wise `.dvc` edits
    matching `render_xml_dvc`'s full re-dump."""
    root = Path(__file__).parents[2]
    paths = sorted((root / 'data').glob('FAUQStats*.xml.dvc'))
    assert len(paths) >= 19
    noncanonical = [
        p.name for p in paths
        if yaml.dump(yaml.safe_load(p.read_text()), sort_keys=False, default_flow_style=False) != p.read_text()
    ]
    assert noncanonical == []


def test_render_xml_dvc_full():
    from njsp.cli.refresh_data import render_xml_dvc
    dvc, content, headers, fetched = GOLDEN_CASES['full']
    assert render_xml_dvc(dvc, content.encode(), headers, date.fromisoformat(fetched)) == (
        'deps:\n'
        f'- path: {URL}\n'
        "  checksum: '\"2f4a1-65f3a0c1d2e3f\"'\n"
        f'  size: {len(content)}\n'
        "  mtime: '2026-11-01T15:20:05+00:00'\n"
        f'{UA_LINE}'
        'outs:\n'
        f'- md5: {hashlib.md5(content.encode()).hexdigest()}\n'
        f'  size: {len(content)}\n'
        '  hash: md5\n'
        '  path: FAUQStats2026.xml\n'
        'meta:\n'
        '  git_tracked: true\n'
        '  import:\n'
        "    fetched: '2026-11-01'\n"
    )


# ── fetch-log: versions committed by the Worker (never logged by a fetch) ──

PRIOR = {'checksum': '"x"', 'size': 193397, 'mtime': '2026-10-31T14:20:04+00:00'}
RUNDATE = 'Sat Oct 31 10:00:04 EDT 2026'


def test_unlogged_capture_record_none_when_logged():
    from njsp.cli.refresh_data import unlogged_capture_record
    last = {'last_modified': 'Sat, 31 Oct 2026 14:20:04 GMT', 'md5': 'aaa'}
    assert unlogged_capture_record(2026, PRIOR, 'bbb', RUNDATE, last) is None


def test_unlogged_capture_record_for_worker_capture():
    from njsp.cli.refresh_data import unlogged_capture_record
    last = {'last_modified': 'Fri, 30 Oct 2026 14:20:05 GMT', 'md5': 'aaa'}
    assert unlogged_capture_record(2026, PRIOR, 'bbb', RUNDATE, last) == {
        'fetch_time': None,
        'year': 2026,
        'last_modified': 'Sat, 31 Oct 2026 14:20:04 GMT',
        'rundate': RUNDATE,
        'content_length': 193397,
        'changed': True,
        'md5': 'bbb',
        'logged_from': 'git',
    }


def test_unlogged_capture_record_metadata_only():
    """NJSP re-publishes prior years daily (new ETag/LM, same bytes) → `changed=False`."""
    from njsp.cli.refresh_data import unlogged_capture_record
    last = {'last_modified': 'Fri, 30 Oct 2026 14:20:05 GMT', 'md5': 'aaa'}
    rec = unlogged_capture_record(2024, PRIOR, 'aaa', RUNDATE, last)
    assert (rec['logged_from'], rec['changed']) == ('git', False)


def test_unlogged_capture_record_legacy_row_without_md5():
    from njsp.cli.refresh_data import unlogged_capture_record
    last = {'last_modified': 'Fri, 30 Oct 2026 14:20:05 GMT', 'md5': float('nan')}
    rec = unlogged_capture_record(2026, PRIOR, 'bbb', RUNDATE, last)
    assert (rec['logged_from'], rec['changed']) == ('git', None)


def test_unlogged_capture_record_no_mtime():
    from njsp.cli.refresh_data import unlogged_capture_record
    assert unlogged_capture_record(2008, {}, 'aaa', None, None) is None


def test_last_logged_by_year():
    import pandas as pd
    from njsp.cli.refresh_data import last_logged_by_year
    log = pd.DataFrame([
        {'year': 2025, 'last_modified': 'a', 'md5': '1'},
        {'year': 2026, 'last_modified': 'b', 'md5': '2'},
        {'year': 2025, 'last_modified': 'c', 'md5': '3'},
    ])
    assert last_logged_by_year(log) == {
        2025: {'year': 2025, 'last_modified': 'c', 'md5': '3'},
        2026: {'year': 2026, 'last_modified': 'b', 'md5': '2'},
    }
    assert last_logged_by_year(None) == {}


def test_rundate_dt():
    assert rundate_dt('Wed Oct 28 10:00:01 EDT 2026').isoformat() == '2026-10-28T10:00:01-04:00'
    assert rundate_dt('Sun Nov 01 10:00:04 EST 2026').isoformat() == '2026-11-01T10:00:04-05:00'
    assert rundate_dt('garbage') is None
    assert rundate_dt(None) is None


def test_is_rollback():
    """2026-11-01: NJSP re-published 10/28's 2026 XML over 10/31's."""
    assert is_rollback('Wed Oct 28 10:00:01 EDT 2026', 'Sat Oct 31 10:00:03 EDT 2026') is True
    assert is_rollback('Sun Nov 01 10:00:04 EST 2026', 'Sat Oct 31 10:00:03 EDT 2026') is False
    # 10:00 EST is an hour after 10:00 EDT on the same wall-clock date
    assert is_rollback('Sat Oct 31 10:00:03 EDT 2026', 'Sat Oct 31 09:30:00 EST 2026') is True
    assert is_rollback('Sat Oct 31 10:00:03 EDT 2026', 'Sat Oct 31 10:00:03 EDT 2026') is False
    assert is_rollback(None, 'Sat Oct 31 10:00:03 EDT 2026') is False
    assert is_rollback('Wed Oct 28 10:00:01 EDT 2026', None) is False
