"""`njdot roads audit`: how well the road sources name crash `road` strings, for one county.

Reads `njdot roads build` inputs (Roadway Network, NG911) + outputs (`road-names`,
`crashes-by-entity`) and, optionally, an OpenStreetMap Overpass JSON dump (`out tags`) of the same
county. OSM names are **only compared, never written anywhere**: OSM is ODbL (share-alike), so
merging its names into published outputs is a licensing decision (specs/road-data-v3.md).
"""
import json
from dataclasses import dataclass
from os.path import join

import pandas as pd

from njdot.road_net import merge_key

OSM_NAME_TAGS = ('name', 'alt_name', 'old_name', 'official_name', 'short_name', 'loc_name', 'name_1', 'reg_name')


def osm_names(path: str) -> pd.DataFrame:
    """Overpass JSON → `(way, tag, name)` rows (`;`-separated multi-values split)."""
    rows = []
    for e in json.load(open(path))['elements']:
        tags = e.get('tags', {})
        for t in OSM_NAME_TAGS:
            for v in (tags.get(t) or '').split(';'):
                if v.strip():
                    rows.append((e['id'], t, v.strip()))
    return pd.DataFrame(rows, columns=['way', 'tag', 'name'])


@dataclass
class Coverage:
    label: str
    n: int
    of: int

    def __str__(self):
        return f'{self.label}: {self.n:,} / {self.of:,} ({self.n / self.of:.1%})' if self.of else f'{self.label}: 0 / 0'


def crash_coverage(cand: pd.DataFrame, keysets: dict[str, set[str]]) -> list[Coverage]:
    """`cand`: one row per crash with a local-name candidate (`key` = its `merge_key`). Share of
    crashes whose candidate is in each named key set."""
    return [Coverage(label, int(cand['key'].isin(keys).sum()), len(cand)) for label, keys in keysets.items()]


def audit(
    cc: int,
    ng911_dir: str,
    roads_dir: str,
    crashes_path: str,
    osm_path: str | None = None,
    top: int = 15,
) -> list[str]:
    """Report lines (see module docstring)."""
    from njdot.cli.roads import alias_candidates
    out = []
    cl = pd.read_parquet(join(ng911_dir, 'centerlines.parquet'))
    al = pd.read_parquet(join(ng911_dir, 'aliases.parquet'))
    cl = cl[(cl['cc_l'] == cc) | (cl['cc_r'] == cc)]
    al = al[al['RCL_NGUID'].isin(set(cl['RCL_NGUID']))]
    ng_prim = set(merge_key(cl['PRIMENAME'].dropna()))
    ng_alias = set(merge_key(al['AST_PNAME'].dropna()))
    ng = ng_prim | ng_alias
    out.append(f'NG911 (cc={cc}): {len(cl):,} segments, {cl["SRI"].notna().mean():.1%} SRI-tagged; '
               f'{len(ng_prim):,} distinct names + {len(ng_alias - ng_prim):,} more via {len(al):,} alias rows')

    names = pd.read_parquet(join(roads_dir, 'road-names.parquet'))
    names = names[names['cc'] == cc]
    by_ent = pd.read_parquet(join(roads_dir, 'crashes-by-entity.parquet'), columns=['entity', 'cc', 'road'])
    by_ent = by_ent[by_ent['cc'] == cc]
    crashes = pd.read_parquet(crashes_path, columns=['sri', 'cc', 'road'])
    crashes = crashes[crashes['cc'] == cc]
    sld = set(merge_key(pd.read_parquet(join(roads_dir, 'sri-geom.parquet'), columns=['sld_name'])['sld_name'].dropna().drop_duplicates()))

    cand = alias_candidates(crashes['road']).rename('cand').to_frame()
    cand['key'] = merge_key(cand['cand']).to_numpy()
    out.append(f'Crashes (cc={cc}) with an SRI: {len(crashes):,}; with a local-name `road` string '
               f'(not blank / a bare route number / an intersection): {len(cand):,}')
    keysets = {'NG911 names + aliases': ng, 'NG911 primary names only': ng_prim, 'NJDOT SLD names': sld}
    osm = None
    if osm_path:
        osm = osm_names(osm_path)
        osm_k = set(merge_key(osm['name']))
        keysets |= {'OSM names (all name tags)': osm_k, 'NG911 ∪ OSM': ng | osm_k, 'NG911 ∪ SLD': ng | sld}
    for c in crash_coverage(cand, keysets):
        out.append(f'  {c}')

    # Own-entity: the crash's `road` string is one of its own entity's searchable names.
    ent_cand = alias_candidates(by_ent['road']).rename('cand').to_frame()
    ent_cand['key'] = merge_key(ent_cand['cand']).to_numpy()
    ent_cand['entity'] = by_ent['entity'].loc[ent_cand.index].to_numpy()
    own = set(zip(names['entity'], merge_key(names['name_display'])))
    hit = pd.Series([(e, k) in own for e, k in zip(ent_cand['entity'], ent_cand['key'])], index=ent_cand.index)
    out.append(f'  crash string is one of its own entity\'s names: {int(hit.sum()):,} / {len(ent_cand):,} ({hit.mean():.1%})')

    miss = cand[~cand['key'].isin(ng)]['cand'].value_counts().head(top)
    out.append(f'Top crash strings not among NG911 names/aliases (cc={cc}):')
    out += [f'  {n:6,}  {s}' for s, n in miss.items()]

    if osm is not None:
        ways = osm.groupby(merge_key(osm['name']).to_numpy())['way'].nunique()
        osm_only = ways[~ways.index.isin(ng)].sort_values(ascending=False)
        ng_in_osm = len(ng_prim & set(ways.index))
        out.append(f'OSM (cc={cc}): {osm["way"].nunique():,} named ways, {len(ways):,} distinct name keys; '
                   f'{len(ways) - len(osm_only):,} ({1 - len(osm_only) / len(ways):.1%}) are NG911 names/aliases, '
                   f'{len(osm_only):,} OSM-only (on {int(osm_only.sum()):,} ways)')
        out.append(f'NG911 primary names also in OSM: {ng_in_osm:,} / {len(ng_prim):,} ({ng_in_osm / len(ng_prim):.1%})')
        by_tag = osm.assign(key=merge_key(osm['name']).to_numpy())
        by_tag = by_tag[~by_tag['key'].isin(ng)].groupby('tag')['key'].nunique().sort_values(ascending=False)
        out.append('OSM-only name keys by tag: ' + ', '.join(f'{t}={n:,}' for t, n in by_tag.items()))
        gain = cand[~cand['key'].isin(ng) & cand['key'].isin(set(ways.index))]['cand'].value_counts().head(top)
        out.append('Top crash strings OSM would add (not NG911):')
        out += [f'  {n:6,}  {s}' for s, n in gain.items()]
        out.append('Top OSM-only names (by way count):')
        disp = osm.assign(key=merge_key(osm['name']).to_numpy()).drop_duplicates('key').set_index('key')['name']
        out += [f'  {n:6,}  {disp[k]}' for k, n in osm_only.head(top).items()]
    return out
