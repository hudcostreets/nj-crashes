import geopandas as gpd
from pandas import Series
from shapely import Point
from shapely.ops import unary_union
from utz import sxs, err

counties = gpd.read_file("tlgdb_2022_a_34_nj.gdb/", layer='County')
counties_union = unary_union(counties.geometry.tolist())


def is_nj_ll(lat, lon):
    point = Point(lon, lat)
    return counties_union.contains(point)


def is_nj(r):
    return is_nj_ll(r.LAT, r.LON)


def get_county(r):
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


county_coords = (
    counties
    .rename(columns={'NAMELSAD': 'name'})
    .groupby('name')
    .apply(county_points)
    .reset_index(level=1, drop=True)
    .reset_index()
)

bnd_lls = sxs(county_coords.name, county_coords.point.apply(lambda p: Series(p, index=['lon', 'lat'])))
ll_hist = bnd_lls[['lat', 'lon']].value_counts()
ll1s = ll_hist[ll_hist == 1]

p1s = bnd_lls.merge(ll1s, left_on=['lat', 'lon'], right_index=True).drop(columns='count')
