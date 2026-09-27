"""Curated per-road crash-assignment overrides (`njdot/data/road_overrides.yml`; specs/road-model-v5.md
§ Overrides).

NJDOT's crash data is historical and rarely changes, so a data quirk found once (a muni that coded one
street's crashes on another's SRI, a crash-report name NG9-1-1 spells differently) can be fixed by
a rule, with its rationale next to it. Each rule matches crashes by their assignment and raw fields
and moves them to another road entity (by slug) or off every road. `njdot roads build` applies them
after placing crashes and records which rule moved each crash (`override`).
"""
import re
from dataclasses import dataclass, field
from os.path import exists

import numpy as np
import pandas as pd
import yaml

from njdot.paths import DOT_DATA

ROAD_OVERRIDES = f'{DOT_DATA}/road_overrides.yml'
# `where` keys: crash columns matched by case-insensitive regex (full match) …
REGEX_KEYS = ('road', 'cross_street', 'sri')
# … exact values (a scalar or a list of allowed values) …
VALUE_KEYS = ('cc', 'mc', 'loc_source', 'severity')
WHERE_KEYS = REGEX_KEYS + VALUE_KEYS + ('years', 'entity', 'mp')


@dataclass
class Override:
    """One rule: `where` (all conditions must hold) → `entity` (a slug; `None` = off every road)."""
    id: str
    note: str
    where: dict
    entity: str | None
    extra: dict = field(default_factory=dict)


def load_overrides(path: str = ROAD_OVERRIDES) -> list[Override]:
    """The rules in `path` (none if it doesn't exist). Raises on unknown keys, duplicate ids, a
    missing `note` or `set.entity`."""
    if not exists(path):
        return []
    with open(path) as f:
        raw = yaml.safe_load(f) or []
    out, seen = [], set()
    for r in raw:
        rid = r['id']
        if rid in seen:
            raise ValueError(f'{path}: duplicate override id {rid!r}')
        seen.add(rid)
        if not str(r.get('note') or '').strip():
            raise ValueError(f'{path}: override {rid!r} has no `note` (rationale)')
        where = r.get('where') or {}
        bad = set(where) - set(WHERE_KEYS)
        if bad:
            raise ValueError(f'{path}: override {rid!r}: unknown `where` keys {sorted(bad)}')
        if not where:
            raise ValueError(f'{path}: override {rid!r} has an empty `where`')
        if 'entity' not in (r.get('set') or {}):
            raise ValueError(f'{path}: override {rid!r} needs `set: {{entity: <slug> | null}}`')
        out.append(Override(id=rid, note=r['note'], where=where, entity=r['set']['entity']))
    return out


def _values(v) -> list:
    return list(v) if isinstance(v, (list, tuple)) else [v]


def override_mask(by_entity: pd.DataFrame, where: dict, slug_of: pd.Series) -> np.ndarray:
    """Which `by_entity` rows a rule's `where` matches. `entity` is a slug (or list of slugs) of the
    crash's current road; `years` an inclusive `[lo, hi]` (or one year); `mp` an inclusive `[lo, hi]`."""
    m = np.ones(len(by_entity), dtype=bool)
    for k, v in where.items():
        if k in REGEX_KEYS:
            rx = re.compile(str(v), re.IGNORECASE)
            col = by_entity[k].astype('string').fillna('').to_numpy(dtype=object)
            m &= np.array([bool(rx.fullmatch(s.strip())) for s in col], dtype=bool)
        elif k in VALUE_KEYS:
            col = by_entity[k]
            vals = _values(v)
            m &= col.isin(vals).fillna(False).to_numpy(dtype=bool)
        elif k == 'years':
            lo, hi = (v, v) if not isinstance(v, (list, tuple)) else (v[0], v[-1])
            m &= by_entity['year'].between(lo, hi).to_numpy()
        elif k == 'mp':
            lo, hi = v
            m &= pd.to_numeric(by_entity['mp'], errors='coerce').between(lo, hi).fillna(False).to_numpy(dtype=bool)
        elif k == 'entity':
            m &= by_entity['entity'].map(slug_of).isin(_values(v)).fillna(False).to_numpy(dtype=bool)
    return m


def apply_overrides(by_entity: pd.DataFrame, rules: list[Override], ents: pd.DataFrame) -> tuple[pd.DataFrame, dict[str, int]]:
    """Apply `rules` in order to `by_entity` (`road_outputs`' crash frame, entity ids renumbered;
    `ents`: `entity, slug`): matched crashes move to the rule's entity (the crash keeps its SRI / MP
    / point; its chain is recomputed downstream) or, with `entity: null`, are dropped (they stay in
    `crashes-by-sri`, with no entity). Adds `override` (the last rule that matched, else NA).
    Returns it and each rule's match count. Raises on a slug that isn't an entity."""
    slug_of = ents.set_index('entity')['slug']
    ent_of = pd.Series(ents['entity'].to_numpy(), index=ents['slug'].to_numpy())
    be = by_entity.copy()
    be['override'] = pd.Series(pd.NA, index=be.index, dtype='string')
    drop = np.zeros(len(be), dtype=bool)
    counts = {}
    for r in rules:
        m = override_mask(be, r.where, slug_of) & ~drop
        counts[r.id] = int(m.sum())
        if not m.any():
            continue
        if r.entity is None:
            drop |= m
        else:
            if r.entity not in ent_of.index:
                raise ValueError(f'override {r.id!r}: no entity with slug {r.entity!r}')
            be.loc[m, 'entity'] = int(ent_of[r.entity])
        be.loc[m, 'override'] = r.id
    return be[~drop].reset_index(drop=True), counts
