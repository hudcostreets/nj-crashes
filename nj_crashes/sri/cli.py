from functools import lru_cache
import json
from os.path import join, exists, dirname
from sqlite3 import connect
from time import sleep
from urllib.parse import urlencode

from click import argument, group, option, pass_context
import numpy as np
import pandas as pd
from pandas import isna
import requests
from utz import err, sxs

import nj_crashes
from nj_crashes.sri.mp05 import SRI_DB_PATH, SRI_DB_TABLE, SRI_DB_URL

SRI_FETCH_CACHE_DIR = '.sri'

COUNTIES = [
    'ATLANTIC',
    'BURLINGTON',
    'CAMDEN',
    'CAPE MAY',
    'CUMBERLAND',
    'BERGEN',
    'ESSEX',
    'GLOUCESTER',
    'HUDSON',
    'HUNTERDON',
    'MERCER',
    'MIDDLESEX',
    'MONMOUTH',
    'MORRIS',
    'OCEAN',
    'PASSAIC',
    'SALEM',
    'SOMERSET',
    'SUSSEX',
    'UNION',
    'WARREN',
]
ALL_ALIASES = ['all', '*']


class FetchError(RuntimeError):
    pass


class MalformedSRIJSON(RuntimeError):
    pass


def get_sri_path(sri):
    return join(f'{SRI_FETCH_CACHE_DIR}', sri)


def load_sri_features(sri, path=None, on_err='warn'):
    path = path or get_sri_path(sri)
    with open(path, 'r') as f:
        responses = json.load(f)
    features = []
    if isinstance(responses, dict):
        responses = [ responses ]
    for idx, response in enumerate(responses):
        if 'features' not in response:
            if 'error' in response:
                msg = f'Error fetching SRI {sri}, response {idx}'
                if on_err == 'raise':
                    raise FetchError(msg)
                elif on_err == 'warn':
                    err(msg)
                    continue
                else:
                    raise ValueError(f"Unrecognized `on_err`: {on_err}")
            else:
                raise MalformedSRIJSON(f'SRI {sri} response {idx} missing "features" and "error": {response}')
        features += response['features']
    return features


def fetch_sri_mps(sri, overwrite=False, log=err, sleep_s=0.5, on_err='warn'):
    path = join(f'{SRI_FETCH_CACHE_DIR}', sri)
    if overwrite or not exists(path):
        page = 0
        offset = 0
        responses = []
        while True:
            query = {
                "where": f"SRI = '{sri}'",
                "units": "esriSRUnit_Meter",
                "outFields": "*",
                "returnGeometry": "true",
                "featureEncoding": "esriDefault",
                "resultOffset": offset,
                "outSR": "4326",
                "orderByFields": "MP",
                "returnExceededLimitFeatures": "true",
                "sqlFormat": "standard",
                "f": "pjson"
            }
            querystring = urlencode(query)
            url = f'https://services.arcgis.com/HggmsDF7UJsNN1FK/arcgis/rest/services/New_Jersey_Standard_Route_Id_And_Milepost/FeatureServer/0/query?{querystring}'
            log(f'Fetching: SRI {sri} MPs from {url}')
            resp = requests.get(url)
            resp.raise_for_status()
            res = resp.json()
            responses.append(res)
            if res.get("exceededTransferLimit"):
                features = res['features']
                num_features = len(features)
                page += 1
                next_offset = offset + num_features
                err(f'Page {page} exceededTransferLimit, {num_features} features, offset {offset} → {next_offset}')
                offset = next_offset
                sleep(sleep_s)
            else:
                break
        with open(path, 'w') as f:
            json.dump(responses, f)
    return load_sri_features(sri, path=path, on_err=on_err)


def check_sri_mps(sri):
    path = get_sri_path(sri)
    if not exists(path):
        return 'missing'
    try:
        features = load_sri_features(sri, path=path, on_err='raise')
        return 'ok' if features else 'empty'
    except FetchError:
        return 'fetch error'
    except MalformedSRIJSON:
        return 'malformed'


def get_sri_sld_name(sri, first=True):
    features = fetch_sri_mps(sri)
    sld_names = [ f['attributes']['SLD_NAME'] for f in features ]
    uniq_sld_names = sorted(set(sld_names))
    if len(uniq_sld_names) == 1 or (first and uniq_sld_names):
        return uniq_sld_names[0]
    else:
        err(f'SRI {sri}: found {len(uniq_sld_names)} SLD_NAMEs:\n{pd.Series(sld_names).value_counts()}')
        return None


def get_sri_mps(sri, conn=None, log=err, refetch=False):
    if not conn and exists(SRI_DB_PATH):
        conn = connect(SRI_DB_PATH)
    query = f'SELECT * FROM {SRI_DB_TABLE} where sri="{sri}"'
    if conn and not refetch:
        res = pd.read_sql(query, conn)
        if not res.empty:
            return res

    features = fetch_sri_mps(sri, log=log, overwrite=refetch)
    if not features:
        err(f'SRI {sri}: no features found')
        return None
    df = pd.DataFrame([
        dict(
            SRI=f['attributes']['SRI'],
            MP=f['attributes']['MP'],
            LON=f['geometry']['x'],
            LAT=f['geometry']['y'],
        )
        for f in features
        if 'geometry' in f
    ]).set_index('SRI')
    log(f'SRI {sri}: writing {len(df)} MPs')
    df.to_sql(SRI_DB_TABLE, SRI_DB_URL, if_exists='append')
    res = pd.read_sql(query, SRI_DB_URL)
    return res


@lru_cache(maxsize=2**15)
def get_sri_mp_map(sri, conn=None, refetch=False):
    mps = get_sri_mps(sri, conn=conn, refetch=refetch)
    if mps is None:
        return None
    ll = mps.apply(lambda r: [ r.LON, r.LAT ], axis=1).rename('LL')
    sri_map = sxs(mps.MP, ll)
    sri_map = sri_map.set_index('MP').sort_index().LL.to_dict()
    return sri_map


def get_mp_ll(sri, mp, conn=None, log=err):
    if isna(mp):
        return
    mps = get_sri_mp_map(sri, conn=conn)
    if not mps:
        if log:
            log(f'No MPs found for SRI {sri}')
        return
    if mp in mps:
        return mps[mp]
    keys = list(mps.keys())
    ordered_mps = sorted([ (key, abs(key - mp)) for key in keys ], key=lambda t: t[1])
    if len(ordered_mps) == 1:
        [(k0, d0)] = ordered_mps
        k1, d1 = k0, d0
    else:
        (k0, d0), (k1, d1) = ordered_mps[:2]
    mp_lo = min(k0, k1)
    mp_hi = max(k0, k1)
    if mp_lo in mps and mp_hi in mps:
        if mp_lo == mp_hi:
            return mps[mp_lo]
        ll_lo = mps[mp_lo]
        ll_hi = mps[mp_hi]
        ll = [ None, None ]
        frac = (mp - mp_lo) / (mp_hi - mp_lo)
        for i in range(2):
            ll[i] = ll_lo[i] + frac * (ll_hi[i] - ll_lo[i])
        return ll
    else:
        raise RuntimeError(f'{sri}@{mp}: recovery error: {mp_lo}, {mp_hi}')


def get_sri_mp_lls(df, cols=None, out_cols=None, conn=None, append=True):
    cols = cols or [ 'sri', 'mp' ]
    sri_col, mp_col = cols
    df_sri_mp = df[(df[sri_col] != '') & (~df[mp_col].isna())].reset_index(drop=True)
    points = df_sri_mp.apply(lambda r: get_mp_ll(sri=r.sri, mp=r.mp, conn=conn), axis=1)
    missing_points = points.isna()
    num_missing_points = missing_points.sum()
    if num_missing_points:
        err(f'{num_missing_points} crashes failed to geocode')
    points = points[~missing_points]
    df_sri_mp = df_sri_mp[~missing_points]
    out_cols = out_cols or ['lon', 'lat']
    lon_col, lat_col = out_cols
    lon = points.apply(lambda p: p[0]).rename(lon_col)
    lat = points.apply(lambda p: p[1]).rename(lat_col)
    if append:
        return sxs(df_sri_mp, lon, lat)
    else:
        return sxs(lon, lat)


overwrite_opt = option('-f', '--overwrite', count=True)
years_opt = option('-y', '--years', default='2020')


@group(help="Various tools related to geocoding Standard Road ID / Mile Post coordinates")
def main():
    pass


@main.command('sri-mps', help="Fetch + Display milepost→{lon,lat} mappings for a given SRI")
@overwrite_opt
@argument('sris', nargs=-1)
def cli_sri_mps(sris, overwrite):
    for sri in sris:
        mps = get_sri_mp_map(sri, refetch=overwrite)
        print(f'{sri}:')
        for mp, ll in mps.items():
            print(f'\t{mp}: {ll}')


@main.group('county', help="County-specific utilities")
@pass_context
@argument('county')
def cli_county(ctx, county):
    ctx.obj = { 'county': county }


@cli_county.command('sris', help="Display SRIs in a given {county,year}'s crash data")
@pass_context
@years_opt
def cli_county_sris(ctx, years):
    county = ctx.obj['county']
    crashes = nj_crashes.crashes.load(years=years, county=county)
    sris = crashes.SRI.unique().tolist()
    print(f'{county}: {len(sris)} SRIs: {sris}')


@cli_county.command('fetch-sris', help="Geocode {SRI,MP} coordinates found in a given {county,year}'s crash records")
@pass_context
@overwrite_opt
@option('-n', '--max-num', type=int, default=1000)
@option('-s', '--sleep-s', type=float, default=0.5)
@option('-j', '--sleep-jitter', type=float, default=0.1)
@years_opt
def cli_county_fetch_sris(ctx, overwrite, max_num, sleep_s, sleep_jitter, years):
    counties = ctx.obj['county']
    counties = COUNTIES if counties.lower() in ALL_ALIASES else counties.split(',')
    for county in counties:
        crashes = nj_crashes.crashes.load(years=years, county=county)
        sris = crashes.SRI.unique().tolist()
        conn = connect(SRI_DB_PATH)
        fetches = 0
        if max_num > 0:
            err(f'{county} county: fetching+caching first {max_num} unfetched SRIs (total SRIs: {len(sris)})')
        else:
            err(f'{county} county: fetching+caching remaining unfetched SRIs (total SRIs: {len(sris)})')
        for sri in sris:
            if not sri:
                continue
            check_result = check_sri_mps(sri)
            if check_result == 'ok':
                if overwrite == 2:
                    err(f"Re-fetching SRI {sri}")
                else:
                    err(f'Found SRI {sri}')
                    continue
            elif check_result == 'empty' and overwrite == 1:
                err(f"Skipping empty SRI: {sri}")
                continue
            else:
                err(f"Fetching SRI {sri} ({check_result})")
            sri_map = get_sri_mp_map(sri, conn=conn, refetch=bool(overwrite))
            fetches += 1
            fetches_str = f'{fetches}/{max_num}' if max_num > 0 else f'{fetches}'
            slp = max(0, round(sleep_s + np.random.normal() * sleep_jitter, 2))
            if sri_map is None:
                err(f"Fetched {fetches_str}: SRI {sri}, no MPs; sleeping for {slp}s")
            else:
                keys = list(sri_map.keys())
                sri_name = get_sri_sld_name(sri)
                mp_range_str = f" ∈ [{min(keys)}, {max(keys)}]" if keys else ""
                err(f"Fetched {fetches_str}: SRI {sri} ({sri_name}), {len(keys)} MPs{mp_range_str}; sleeping for {slp}s")
            if max_num > 0 and fetches >= max_num:
                break
            sleep(slp)


@cli_county.command('crash-lls', help="Generate a Plotly Mapbox scatterplot of crashes in a given {county,year}")
@pass_context
@option('-h', '--height', type=int, default=1000)
@option('-w', '--width', type=int, default=1000)
@years_opt
def cli_county_fetch_sris(ctx, width, height, years):
    county = ctx.obj['county']
    crashes = nj_crashes.crashes.load(years=years, county=county)
    conn = connect(SRI_DB_PATH)
    cc_lls = get_sri_mp_lls(crashes, conn=conn)
    path = f'{county}-crashes.png'
    err(f"Got county {county} LLs, plotting to {path}")
    import plotly.express as px
    fig = px.scatter_mapbox(
        cc_lls,
        lon='LON', lat='LAT',
        color='Severity',
        color_discrete_sequence=['yellow', 'orange', 'red'],
        hover_data=['Date', 'Crash Location', 'SRI', 'MP'],
        center=dict(lon=-74.042037, lat=40.725527),
        zoom=13.5,
        height=600,
    )
    legend_bgcolor = '50'
    token = open(".mapbox-token").read()
    fig.update_layout(
        mapbox=dict(
            style="dark",
            accesstoken=token,
        ),
        margin={"r": 0, "t": 0, "l": 0, "b": 0},
        title=dict(
            text=f"{county} County crashes (2020)",
            x=0.5, y=0.98,
            xanchor='center', yanchor='top',
            font=dict(size=32, color="white")
        ),
        legend=dict(
            title=dict(text=''),
            x=0.98, y=0.98,
            xanchor="right", yanchor="top",
            font=dict(
                size=14,
                color="white"
            ),
            bgcolor=f"rgba({legend_bgcolor},{legend_bgcolor},{legend_bgcolor},0.8)",
            bordercolor="white",
            borderwidth=2,
        ),
    )
    fig.write_image(path, width=width, height=height)


if __name__ == '__main__':
    main()


# https://services.arcgis.com/HggmsDF7UJsNN1FK/arcgis/rest/services/New_Jersey_Standard_Route_Id_And_Milepost/FeatureServer/0/query?f=json&returnIdsOnly=true&returnCountOnly=true&where=1=1&returnGeometry=false&spatialRel=esriSpatialRelIntersects&geometry={"xmin":-8243090.172003703,"ymin":4972787.522867611,"xmax":-8241361.978567464,"ymax":4973803.896478005,"spatialReference":{"wkid":102100}}&geometryType=esriGeometryEnvelope&inSR=102100&outSR=102100

# Grove MPs by SRI:
# {
#     "where": "SRI = '09061720__'",
#     "geometryType": "esriGeometryEnvelope",
#     "inSR": "102100",
#     "spatialRel": "esriSpatialRelIntersects",
#     "resultType": "none",
#     "distance": "0.0",
#     "units": "esriSRUnit_Meter",
#     "returnGeodetic": "false",
#     "outFields": "*",
#     "returnGeometry": "true",
#     "featureEncoding": "esriDefault",
#     "multipatchOption": "xyFootprint",
#     "outSR": "4326",
#     "applyVCSProjection": "false",
#     "returnIdsOnly": "false",
#     "returnUniqueIdsOnly": "false",
#     "returnCountOnly": "false",
#     "returnExtentOnly": "false",
#     "returnQueryGeometry": "false",
#     "returnDistinctValues": "false",
#     "cacheHint": "false",
#     "orderByFields": "MP",
#     "returnZ": "false",
#     "returnM": "false",
#     "returnExceededLimitFeatures": "true",
#     "sqlFormat": "standard",
#     "f": "pjson"
# }
# https://services.arcgis.com/HggmsDF7UJsNN1FK/ArcGIS/rest/services/New_Jersey_Standard_Route_Id_And_Milepost/FeatureServer/0/query?where=SRI+%3D+%2709061720__%27&objectIds=&time=&geometry=&geometryType=esriGeometryEnvelope&inSR=102100&spatialRel=esriSpatialRelIntersects&resultType=none&distance=0.0&units=esriSRUnit_Meter&relationParam=&returnGeodetic=false&outFields=*&returnGeometry=true&featureEncoding=esriDefault&multipatchOption=xyFootprint&maxAllowableOffset=&geometryPrecision=&outSR=4326&defaultSR=&datumTransformation=&applyVCSProjection=false&returnIdsOnly=false&returnUniqueIdsOnly=false&returnCountOnly=false&returnExtentOnly=false&returnQueryGeometry=false&returnDistinctValues=false&cacheHint=false&orderByFields=MP&groupByFieldsForStatistics=&outStatistics=&having=&resultOffset=&resultRecordCount=&returnZ=false&returnM=false&returnExceededLimitFeatures=true&quantizationParameters=&sqlFormat=standard&f=pjson&token=
