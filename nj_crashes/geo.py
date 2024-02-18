from functools import cache

import geopandas as gpd
from pandas import Series
from shapely import Point
from shapely.ops import unary_union
from utz import sxs, err

from nj_crashes import ROOT_DIR


@cache
def get_counties():
    gpd_path = f"{ROOT_DIR}/tlgdb_2022_a_34_nj.gdb/"
    err(f"Loading {gpd_path}")
    return gpd.read_file(gpd_path, layer='County')


@cache
def get_county_geometries():
    counties = get_counties()
    counties['cn'] = counties.NAMELSAD.str.replace(' County$', '', regex=True)
    return counties.set_index('cn')[['geometry']]


@cache
def get_counties_union():
    return unary_union(get_counties().geometry.tolist())


def is_nj_ll(lat, lon):
    point = Point(lon, lat)
    return get_counties_union().contains(point)


def is_nj(r):
    return is_nj_ll(r.LAT, r.LON)


def get_county(r):
    counties = get_counties()
    hits = counties[counties.geometry.contains(Point(r.LON, r.LAT))].NAMELSAD
    if len(hits) > 1:
        err(f"{r}: {len(hits)} counties: {hits}")
        return
    elif hits.empty:
        return
    [county] = hits.tolist()
    return county


def county_points(r):
    [name] = r.index.unique()
    [multilinestr] = r.geometry.boundary.tolist()
    linestrs = multilinestr.geoms
    if len(linestrs) > 1:
        err(f'{name}: {len(linestrs)} linestrings')
    #         return None
    #     [linestr] = linestrs
    return Series([ c for l in linestrs for c in l.coords ], name='point')


@cache
def get_county_coords():
    return (
        get_counties()
        .rename(columns={'NAMELSAD': 'name'})
        .groupby('name')
        .apply(county_points)
        .reset_index(level=1, drop=True)
        .reset_index()
    )


@cache
def get_boundary_lls(county=None):
    county_coords = get_county_coords()
    df = sxs(county_coords.name, county_coords.point.apply(lambda p: Series(p, index=['lon', 'lat'])))
    df.name = df.name.str.replace(' County', '')
    if county:
        df = df[df.name == county]
    return df


@cache
def get_boundary_ll_map():
    boundary_ll_map = get_boundary_lls().groupby('name').apply(lambda df: df.apply(lambda r: [ r.lon, r.lat ], axis=1).tolist()).to_dict()
    return boundary_ll_map

@cache
def get_nj_points():
    boundary_lls = get_boundary_lls()
    ll_hist = boundary_lls[['lat', 'lon']].value_counts()
    ll1s = ll_hist[ll_hist == 1]

    p1s = boundary_lls.merge(ll1s, left_on=['lat', 'lon'], right_index=True).drop(columns='count')
    return p1s
