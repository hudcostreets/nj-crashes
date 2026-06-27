"""Retry helpers for HTTP fetches and PyGithub API calls.

Both wrappers honor a `Retry-After` header when present (in seconds or
HTTP-date form), and fall back to capped exponential backoff with jitter.

GitHub's "secondary" rate limit returns 429 with a textual "temporarily being
throttled" message; PyGithub auto-retries the primary (X-RateLimit-Remaining)
limit but not this one. `with_gh_retry` covers the gap. `http_get_with_retry`
covers transient upstream failures (the NJSP feed has thrown 403/5xx).
"""
from __future__ import annotations

import random
import time
from email.utils import parsedate_to_datetime
from datetime import datetime, timezone
from functools import wraps

import requests
from github import GithubException

from .log import err


GH_RETRY_STATUSES = frozenset({429, 502, 503, 504})
HTTP_RETRY_STATUSES = frozenset({403, 408, 429, 500, 502, 503, 504})


def _parse_retry_after(value: str | None) -> float | None:
    """Parse a Retry-After header value (seconds-int or HTTP-date)."""
    if not value:
        return None
    try:
        return float(int(value))
    except (TypeError, ValueError):
        pass
    try:
        when = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    if when is None:
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    return max(0.0, (when - datetime.now(timezone.utc)).total_seconds())


def _backoff_seconds(attempt: int, base: float = 5.0, cap: float = 60.0) -> float:
    """Exponential backoff with jitter, capped at `cap`."""
    return min(cap, base * (2 ** attempt)) + random.uniform(0, base / 2)


def with_gh_retry(max_attempts: int = 5, base: float = 5.0, cap: float = 60.0):
    """Decorator: retry the wrapped fn on transient GitHub API failures."""
    def deco(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            for attempt in range(max_attempts):
                try:
                    return fn(*args, **kwargs)
                except GithubException as e:
                    if e.status not in GH_RETRY_STATUSES or attempt == max_attempts - 1:
                        raise
                    headers = getattr(e, 'headers', None) or {}
                    retry_after = _parse_retry_after(
                        headers.get('retry-after') or headers.get('Retry-After')
                    )
                    sleep_s = retry_after if retry_after is not None else _backoff_seconds(attempt, base, cap)
                    err(f"GH API {e.status}; sleeping {sleep_s:.1f}s (attempt {attempt + 1}/{max_attempts})")
                    time.sleep(sleep_s)
        return wrapper
    return deco


def http_get_with_retry(
    url: str,
    *,
    headers: dict | None = None,
    timeout: float = 30,
    max_attempts: int = 4,
    base: float = 3.0,
    cap: float = 30.0,
    retry_statuses: frozenset[int] = HTTP_RETRY_STATUSES,
) -> requests.Response:
    """GET `url` with retry on transient failures (connection errors + listed
    statuses, including 403 — observed transiently from the NJSP feed).

    Returns the final `Response` (which may still be non-200 after exhausting
    attempts — the caller decides whether to raise).
    """
    last_res = None
    for attempt in range(max_attempts):
        try:
            res = requests.get(url, allow_redirects=True, timeout=timeout, headers=headers)
        except requests.RequestException as e:
            if attempt == max_attempts - 1:
                raise
            sleep_s = _backoff_seconds(attempt, base, cap)
            err(f"GET {url}: {e}; sleeping {sleep_s:.1f}s (attempt {attempt + 1}/{max_attempts})")
            time.sleep(sleep_s)
            continue
        last_res = res
        if res.status_code not in retry_statuses or attempt == max_attempts - 1:
            return res
        retry_after = _parse_retry_after(res.headers.get('Retry-After'))
        sleep_s = retry_after if retry_after is not None else _backoff_seconds(attempt, base, cap)
        err(f"GET {url}: {res.status_code} {res.reason}; sleeping {sleep_s:.1f}s (attempt {attempt + 1}/{max_attempts})")
        time.sleep(sleep_s)
    return last_res
