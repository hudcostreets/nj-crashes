from os.path import join
from typing import Union
from urllib.parse import urlparse

from contextlib import contextmanager
from tempfile import TemporaryDirectory
from urllib.parse import ParseResult

from utz import s3

from nj_crashes.utils.log import err


S3URL = Union[ParseResult, str]


def upload(path: str, s3_url: S3URL):
    if isinstance(s3_url, str):
        s3_url = urlparse(s3_url)
    if s3_url.scheme != 's3':
        raise ValueError(f"Expected s3:// URL, got {s3_url}")
    bucket = s3_url.netloc
    key = s3_url.path.lstrip('/')
    s3.client().upload_file(path, bucket, key)
    err(f"Uploaded {path} to s3://{bucket}/{key}")


@contextmanager
def s3_upload_ctx(s3_url: S3URL):
    with TemporaryDirectory() as tmpdir:
        tmp_path = join(tmpdir, 'tmpfile')
        yield tmp_path
        upload(tmp_path, s3_url)


@contextmanager
def output_ctx(url: S3URL):
    if isinstance(url, str):
        url = urlparse(url)
    if url.scheme == 's3':
        with s3_upload_ctx(url) as tmp_path:
            yield tmp_path
    elif not url.scheme:
        yield url.path
    else:
        raise ValueError(f"Unsupported scheme: {url.scheme}")


@contextmanager
def input_ctx(url: S3URL):
    if isinstance(url, str):
        url = urlparse(url)
    if url.scheme == 's3':
        import boto3
        client = boto3.client('s3')
        bucket = url.netloc
        key = url.path.lstrip('/')
        with TemporaryDirectory() as tmpdir:
            tmp_path = join(tmpdir, 'tmpfile')
            client.download_file(bucket, key, tmp_path)
            yield tmp_path
    elif not url.scheme:
        yield url.path
    else:
        raise ValueError(f"Unsupported scheme: {url.scheme}")
