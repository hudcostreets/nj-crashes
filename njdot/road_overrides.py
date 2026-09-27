"""Curated per-road crash-assignment overrides (`njdot/data/road_overrides.yml`; specs/road-model-v5.md
§ Overrides).

NJDOT's crash data is historical and rarely changes, so a data quirk found once (a muni that coded one
street's crashes on another's SRI, a crash-report name NG9-1-1 spells differently) can be fixed by
a rule, with its rationale next to it. Two kinds:

- **`set`** rules match crashes by their assignment and raw fields and move them to another road
  entity (by slug) or off every road. `njdot roads build` applies them after placing crashes.
- **`recode`** rules rewrite a crash's raw location fields (`sri`, `mp`, `road`, `cross_street`)
  *before* recovery, which then places it as if NJDOT had coded it so: they reach crashes that
  recovery would leave off every road (Newark's 2001–02 Broadway crashes, coded to CR 649's SRI).

Either way the build records which rule touched each crash (`override`).
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
# … of which a `recode` rule (before recovery: no road assignment yet) can use these.
RECODE_WHERE_KEYS = REGEX_KEYS + ('cc', 'mc', 'severity', 'years', 'mp')
# The raw fields a `recode` rule can rewrite.
RECODE_KEYS = ('sri', 'mp', 'road', 'cross_street')


@dataclass
class Override:
    """One rule: `where` (all conditions must hold) → `entity` (a slug; `None` = off every road), or,
    for a `recode` rule, → the raw field values in `recode`."""
    id: str
    note: str
    where: dict
    entity: str | None
    extra: dict = field(default_factory=dict)
    recode: dict | None = None


def load_overrides(path: str = ROAD_OVERRIDES) -> list[Override]:
    """The rules in `path` (none if it doesn't exist), `set` and `recode` ones in file order. Raises on
    unknown keys, duplicate ids, a missing `note`, a rule with neither (or both) of `set.entity` /
    `recode`, or a `recode` rule matching on its crash's road assignment."""
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
        if 'recode' in r:
            if 'set' in r:
                raise ValueError(f'{path}: override {rid!r} has both `set` and `recode`')
            rc = r['recode'] or {}
            bad = set(rc) - set(RECODE_KEYS)
            if bad or not rc:
                raise ValueError(f'{path}: override {rid!r}: `recode` keys must be some of {list(RECODE_KEYS)} (got {sorted(rc)})')
            bad = set(where) - set(RECODE_WHERE_KEYS)
            if bad:
                raise ValueError(f'{path}: override {rid!r}: a `recode` rule runs before recovery; it can\'t match on {sorted(bad)}')
            out.append(Override(id=rid, note=r['note'], where=where, entity=None, recode=dict(rc)))
            continue
        if 'entity' not in (r.get('set') or {}):
            raise ValueError(f'{path}: override {rid!r} needs `set: {{entity: <slug> | null}}` or `recode: {{…}}`')
        out.append(Override(id=rid, note=r['note'], where=where, entity=r['set']['entity']))
    return out


def apply_recodes(crashes: pd.DataFrame, rules: list[Override]) -> tuple[pd.DataFrame, dict[str, int]]:
    """Apply the `recode` rules of `rules`, in order, to raw `crashes` (before recovery): matching
    crashes' fields are replaced by the rule's `recode` values. Adds `_recode` (the last rule that
    matched, else NA; the build carries it into `override`). Returns it and each rule's match count."""
    c = crashes.copy()
    c['_recode'] = pd.Series(pd.NA, index=c.index, dtype='string')
    counts = {}
    for r in rules:
        if r.recode is None:
            continue
        m = override_mask(c, r.where, pd.Series(dtype=object))
        counts[r.id] = int(m.sum())
        if not m.any():
            continue
        for k, v in r.recode.items():
            if k == 'mp':
                c.loc[m, k] = np.nan if v is None else float(v)
            else:
                c[k] = c[k].astype('string')
                c.loc[m, k] = pd.NA if v is None else str(v)
        c.loc[m, '_recode'] = r.id
    return c, counts


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
    Returns it and each rule's match count. Raises on a slug that isn't an entity. `recode` rules
    (`apply_recodes`, applied before recovery) are skipped here; a crash one rewrote carries its id
    in `_recode`, which seeds `override`."""
    slug_of = ents.set_index('entity')['slug']
    ent_of = pd.Series(ents['entity'].to_numpy(), index=ents['slug'].to_numpy())
    be = by_entity.copy()
    be['override'] = be.pop('_recode').astype('string') if '_recode' in be else pd.Series(pd.NA, index=be.index, dtype='string')
    drop = np.zeros(len(be), dtype=bool)
    counts = {}
    for r in rules:
        if r.recode is not None:
            continue
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
