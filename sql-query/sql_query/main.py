from sys import stdout

import json

import sqlite3

from urllib.parse import urlparse

import apsw
import click
import s3fs
import s3sqlite


def dict_factory(cursor, row):
    d = {}
    for idx, col in enumerate(cursor.getdescription()):
        d[col[0]] = row[idx]
    return d


@click.command
@click.argument('url')
@click.argument('query')
def main(url, query):
    parsed = urlparse(url)
    scheme = parsed.scheme
    if scheme == 'file' or not scheme:
        ctx = sqlite3.connect(url)
        with ctx as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.execute(query)
            rows = list(map(dict, cursor.fetchall()))
    else:
        if scheme == 'https':
            domain_suffix = '.s3.amazonaws.com'
            if parsed.netloc.endswith(domain_suffix):
                bucket = parsed.netloc[:-len(domain_suffix)]
                key = parsed.path[1:]
                key_prefix = f"{bucket}/{key}"
            else:
                raise ValueError(f"Unsupported HTTPS URL {url}, must be an S3 URL like https://bucket{domain_suffix}/key")
        elif scheme == 's3':
            key_prefix = f"{parsed.netloc}{parsed.path}"
        else:
            raise ValueError(f"Unsupported URL scheme {scheme}")
        s3 = s3fs.S3FileSystem()
        s3vfs = s3sqlite.S3VFS(name="s3-vfs", fs=s3)
        ctx = apsw.Connection(key_prefix, vfs=s3vfs.name, flags=apsw.SQLITE_OPEN_READONLY)
        with ctx as conn:
            cursor = conn.cursor()
            cursor.setrowtrace(dict_factory)
            cursor.execute(query)
            rows = cursor.fetchall()

    json.dump(rows, stdout, indent=2)


if __name__ == "__main__":
    main()
