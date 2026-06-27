from unittest.mock import MagicMock, patch

import pytest
import requests
from github import GithubException

from nj_crashes.utils.retry import (
    _parse_retry_after,
    http_get_with_retry,
    with_gh_retry,
)


def test_parse_retry_after_seconds():
    assert _parse_retry_after("5") == 5.0
    assert _parse_retry_after("0") == 0.0


def test_parse_retry_after_none_or_bad():
    assert _parse_retry_after(None) is None
    assert _parse_retry_after("") is None
    assert _parse_retry_after("garbage") is None


def test_parse_retry_after_http_date_clamped_nonnegative():
    # Past dates should clamp to 0 (already past); future dates positive.
    past = _parse_retry_after("Wed, 01 Jan 2020 00:00:00 GMT")
    assert past == 0.0
    future = _parse_retry_after("Wed, 01 Jan 2099 00:00:00 GMT")
    assert future is not None and future > 0


def _resp(status_code: int, headers: dict | None = None, content: bytes = b"ok"):
    r = MagicMock(spec=requests.Response)
    r.status_code = status_code
    r.reason = "Reason"
    r.headers = headers or {}
    r.content = content
    return r


def test_http_get_returns_immediately_on_200():
    with patch("nj_crashes.utils.retry.requests.get") as g, \
         patch("nj_crashes.utils.retry.time.sleep") as sleep:
        g.return_value = _resp(200)
        res = http_get_with_retry("http://x", max_attempts=3)
    assert res.status_code == 200
    assert g.call_count == 1
    sleep.assert_not_called()


def test_http_get_retries_on_403_then_succeeds():
    # NJSP 6/26 failure: transient 403, recovers on retry.
    with patch("nj_crashes.utils.retry.requests.get") as g, \
         patch("nj_crashes.utils.retry.time.sleep") as sleep:
        g.side_effect = [_resp(403), _resp(200)]
        res = http_get_with_retry("http://x", max_attempts=3, base=0.01, cap=0.01)
    assert res.status_code == 200
    assert g.call_count == 2
    assert sleep.call_count == 1


def test_http_get_honors_retry_after():
    with patch("nj_crashes.utils.retry.requests.get") as g, \
         patch("nj_crashes.utils.retry.time.sleep") as sleep:
        g.side_effect = [_resp(429, headers={"Retry-After": "7"}), _resp(200)]
        http_get_with_retry("http://x", max_attempts=3, base=0.01)
    sleep.assert_called_once_with(7.0)


def test_http_get_exhausts_attempts_and_returns_last_response():
    with patch("nj_crashes.utils.retry.requests.get") as g, \
         patch("nj_crashes.utils.retry.time.sleep"):
        g.return_value = _resp(503)
        res = http_get_with_retry("http://x", max_attempts=3, base=0.01)
    assert res.status_code == 503
    assert g.call_count == 3


def test_http_get_passes_404_through_without_retry():
    # 404 not in default retry_statuses — should return on first attempt.
    with patch("nj_crashes.utils.retry.requests.get") as g, \
         patch("nj_crashes.utils.retry.time.sleep") as sleep:
        g.return_value = _resp(404)
        res = http_get_with_retry("http://x", max_attempts=3)
    assert res.status_code == 404
    assert g.call_count == 1
    sleep.assert_not_called()


def test_http_get_retries_on_connection_error():
    with patch("nj_crashes.utils.retry.requests.get") as g, \
         patch("nj_crashes.utils.retry.time.sleep") as sleep:
        g.side_effect = [requests.ConnectionError("nope"), _resp(200)]
        res = http_get_with_retry("http://x", max_attempts=3, base=0.01)
    assert res.status_code == 200
    assert sleep.call_count == 1


def test_gh_retry_returns_immediately_on_success():
    calls = []

    @with_gh_retry(max_attempts=3, base=0.01, cap=0.01)
    def fn():
        calls.append(1)
        return "ok"

    assert fn() == "ok"
    assert calls == [1]


def test_gh_retry_429_then_success():
    seq = [
        GithubException(429, {"message": "throttled"}, {"Retry-After": "0"}),
        "ok",
    ]
    calls = []

    @with_gh_retry(max_attempts=3, base=0.01, cap=0.01)
    def fn():
        calls.append(1)
        v = seq.pop(0)
        if isinstance(v, Exception):
            raise v
        return v

    with patch("nj_crashes.utils.retry.time.sleep") as sleep:
        assert fn() == "ok"
    assert len(calls) == 2
    sleep.assert_called_once_with(0.0)


def test_gh_retry_non_retryable_status_raises_immediately():
    @with_gh_retry(max_attempts=3, base=0.01, cap=0.01)
    def fn():
        raise GithubException(404, {"message": "not found"}, {})

    with pytest.raises(GithubException) as ei:
        fn()
    assert ei.value.status == 404


def test_gh_retry_exhausts_attempts_and_raises_last():
    @with_gh_retry(max_attempts=3, base=0.01, cap=0.01)
    def fn():
        raise GithubException(429, {"message": "throttled"}, {})

    with patch("nj_crashes.utils.retry.time.sleep"):
        with pytest.raises(GithubException) as ei:
            fn()
    assert ei.value.status == 429
