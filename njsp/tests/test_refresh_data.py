"""Unit tests for `njsp.cli.refresh_data.update_xml_dvc`.

Guards the code path that keeps `data/FAUQStats*.xml.dvc` in sync with
each daily fetch's response headers (ETag, Last-Modified). A regression
here would desync the `.dvc` deps section from the git-tracked XML,
breaking `dvx update` as a fallback fetcher.
"""
from pathlib import Path
from unittest.mock import patch

import pytest
import yaml

from njsp.cli.refresh_data import update_xml_dvc


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
