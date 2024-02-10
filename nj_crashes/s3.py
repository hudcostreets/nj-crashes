from os.path import join
from typing import Union
from urllib.parse import urlparse

from contextlib import contextmanager
from tempfile import TemporaryDirectory
from urllib.parse import ParseResult

from nj_crashes.utils import err


@contextmanager
def s3_upload_ctx(s3_url: Union[ParseResult, str]):
    if isinstance(s3_url, str):
        s3_url = urlparse(s3_url)
        if s3_url.scheme != 's3':
            raise ValueError(f"Expected s3:// URL, got {s3_url}")
    with TemporaryDirectory() as tmpdir:
        tmp_path = join(tmpdir, 'tmpfile')
        yield tmp_path
        import boto3
        client = boto3.client('s3')
        bucket = s3_url.netloc
        key = s3_url.path.lstrip('/')
        client.upload_file(tmp_path, bucket, key)
        err(f"Uploaded {tmp_path} to {bucket}/{key}")


@contextmanager
def output_ctx(url: Union[ParseResult, str]):
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
def input_ctx(url: Union[ParseResult, str]):
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
