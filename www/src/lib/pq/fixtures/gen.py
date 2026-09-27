#!/usr/bin/env python
"""Write `sample.parquet`, the `pq` tests' fixture: 16 rows sorted by `entity`, 4-row row groups,
ZSTD, statistics on the sort / range columns only (like the road files), and a kv-metadata entry.

Regenerate: `/path/to/venv/python src/lib/pq/fixtures/gen.py` (needs pyarrow)."""
import json
from datetime import datetime
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

rows = [
    # entity, name, chain, id, dt, flag
    (1, "alpha", 0.5, 10, "2020-01-01", True),
    (1, "alpha", None, 11, "2020-01-02", None),
    (1, "alpha", 1.5, None, "2020-01-03", False),
    (2, "bravo", 0.25, 12, "2020-02-01", True),
    (2, "bravo", 3.0, 13, "2020-02-02", False),
    (3, "charlie", None, 14, "2020-03-01", None),
    (3, "charlie", 2.0, 15, "2020-03-02", True),
    (4, "delta", 5.0, 16, "2020-04-01", False),
    (5, "echo", 6.5, 17, "2020-05-01", True),
    (5, "echo", 7.0, 18, "2020-05-02", False),
    (6, "foxtrot", None, 19, "2020-06-01", None),
    (6, "foxtrot", None, 20, "2020-06-02", None),
    (7, "golf", 8.0, 21, "2020-07-01", True),
    (8, "hotel", 9.0, 22, "2020-08-01", False),
    (8, "hotel", 9.5, 23, "2020-08-02", True),
    (9, "india", 10.0, 24, "2020-09-01", False),
]
cols = list(zip(*rows))
table = pa.table({
    "entity": pa.array(cols[0], pa.int32()),
    "name": pa.array(cols[1], pa.string()),
    "chain": pa.array(cols[2], pa.float32()),
    "id": pa.array(cols[3], pa.int64()),
    "dt": pa.array([datetime.fromisoformat(d) for d in cols[4]], pa.timestamp("ns")),
    "flag": pa.array(cols[5], pa.bool_()),
})
table = table.replace_schema_metadata({"capped": json.dumps({"alpha": 3, "hotel": 2})})
out = Path(__file__).parent / "sample.parquet"
pq.write_table(
    table, out,
    row_group_size=4,
    compression="zstd",
    write_statistics=["entity", "name", "chain"],
)
print(out)
