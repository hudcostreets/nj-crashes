import pandas as pd

import njdot.load as load


def setup(monkeypatch, tmp_path, backfill: bool):
    # crashes.parquet: `id` is the index, not a column.
    crashes = pd.DataFrame({
        'year': [2021, 2022],
        'cc': [9, 9], 'mc': [6, 6], 'case': ['a', 'b'],
        'sri': ['S1', None], 'mp': [1.0, None], 'ilat': [40.1, None], 'ilon': [-74.1, None],
    }, index=pd.Index([100, 101], name='id'))
    # AASHTO: later years, no `id` at all.
    aashto = pd.DataFrame({
        'year': [2023], 'cc': [9], 'mc': [6], 'case': ['c'],
        'sri': ['S2'], 'mp': [2.0], 'ilat': [40.2], 'ilon': [-74.2],
    })
    crashes.to_parquet(tmp_path / 'crashes.parquet')
    aashto.to_parquet(tmp_path / 'aashto.parquet', index=False)
    monkeypatch.setattr(load, 'CRASHES_PQT', str(tmp_path / 'crashes.parquet'))
    monkeypatch.setattr(load, 'AASHTO_SUPPLEMENTED_CRASHES', str(tmp_path / 'aashto.parquet'))
    bf_path = tmp_path / 'backfill.parquet'
    if backfill:
        pd.DataFrame({
            'id': [101], 'year': [2022], 'cc': [9], 'mc': [6], 'case': ['b'],
            'sri': ['S9'], 'mp': [9.0], 'ilat': [40.9], 'ilon': [-74.9],
        }).to_parquet(bf_path, index=False)
    monkeypatch.setattr(load, 'CRASHES_GEOCODE_BACKFILL', str(bf_path))


def test_columns_with_id_and_backfill(monkeypatch, tmp_path):
    setup(monkeypatch, tmp_path, backfill=True)
    df = load.load_crashes_with_aashto(columns=['year', 'case', 'sri', 'mp', 'ilat', 'ilon', 'id'])
    assert df[['id', 'year', 'case', 'sri', 'mp']].astype(object).where(df.notna(), None).values.tolist() == [
        [100, 2021, 'a', 'S1', 1.0],
        [101, 2022, 'b', 'S9', 9.0],  # filled from the backfill, joined on `id`
        [None, 2023, 'c', 'S2', 2.0],  # AASHTO row: no `id`
    ]


def test_columns_with_id_without_backfill(monkeypatch, tmp_path):
    setup(monkeypatch, tmp_path, backfill=False)
    df = load.load_crashes_with_aashto(columns=['year', 'case', 'id'])
    assert df[['id', 'year', 'case']].astype(object).where(df.notna(), None).values.tolist() == [
        [100, 2021, 'a'],
        [101, 2022, 'b'],
        [None, 2023, 'c'],
    ]


def test_columns_without_id_drops_it(monkeypatch, tmp_path):
    setup(monkeypatch, tmp_path, backfill=True)
    df = load.load_crashes_with_aashto(columns=['year', 'case'])
    assert df.columns.tolist() == ['year', 'case']
