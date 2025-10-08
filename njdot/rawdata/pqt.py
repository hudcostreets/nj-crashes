import json
import pandas as pd
import re
from utz import err

from njdot.paths import DOT_DATA
from njdot.data import FIELDS_DIR
from njdot.tbls import types_opt, TYPE_TO_FIELDS
from .base import rawdata
from .utils import regions_opt, years_opt, dry_run_skip, overwrite_opt, dry_run_opt
from .parse import load, get_2021_dob_fix_fields, get_2023_vehicles_fix_fields


D4 = re.compile(r'\d{4}')
D2 = re.compile(r'\d\d')
D1 = re.compile(r'\d')
D1_2 = re.compile(r'(?P<h>\d) (?P<mm>\d\d)')


def build_dt(r):
    crash_date = r['Crash Date']
    crash_time = r['Crash Time']
    date_str = crash_date
    time_str = None
    if crash_time:
        if D4.fullmatch(crash_time):
            time_str = f'{crash_time}'
        elif D2.fullmatch(crash_time):
            if crash_time != "00":
                time_str = f'{crash_time}00'
        elif D1.fullmatch(crash_time):
            if crash_time != "0":
                time_str = f'0{crash_time}00'
        elif m := D1_2.fullmatch(crash_time):
            time_str = f"0{m['h']}{m['mm']}"

    if time_str:
        dt_str = f'{date_str} {time_str}'
    else:
        dt_str = date_str
        if crash_time:
            err(f'Dropping unrecognized "Crash Time": "{crash_time}"')

    return pd.to_datetime(dt_str)


def cmd(*opts, help=None):
    """Decorator to create commands with common options (regions, types, years)."""
    def wrapper(fn):
        decos = (
            rawdata.command(fn.__name__, short_help=help),
            regions_opt,
            types_opt,
            years_opt,
        ) + opts
        for deco in reversed(decos):
            fn = deco(fn)
        return fn
    return wrapper


@cmd(
    overwrite_opt,
    dry_run_opt,
    help='Convert 1 or more unzipped {year, county} `.txt` files to `.pqt`s, with some dtypes and cleanup'
)
def pqt(regions, types, years, overwrite, dry_run):
    fields_dict = {}
    for year in years:
        # Load `fields` dict for `year`
        v2017 = year >= 2017
        for region in regions:
            for typ in types:
                parent_dir = f'{DOT_DATA}/{year}'
                table = TYPE_TO_FIELDS[typ]
                name = f'{parent_dir}/{region}{year}{typ}'
                txt_path = f'{name}.txt'
                pqt_path = f'{name}.pqt'
                json_name = f'{2017 if v2017 else 2001}{table}Table.json'
                json_path = f'{FIELDS_DIR}/{json_name}'
                if json_path in fields_dict:
                    fields = fields_dict[json_path]
                else:
                    with open(json_path, 'r') as f:
                        fields = json.load(f)
                        fields_dict[json_path] = fields
                    if typ == 'Crash' and year == 2013 and region == 'Atlantic':
                        # For some reason, "Reporting Badge No." in Atlantic2013[Accidents] is 18 chars long, not 5
                        [ *fields, rest ] = fields
                        fields = [ *fields, { **rest, 'Length': 18 } ]
                        err(f'{pqt_path}: overwrote final field length to 18 (was: {rest})')
                if dry_run_skip(txt_path, pqt_path, dry_run=dry_run, overwrite=overwrite):
                    continue

                if typ == 'Accidents':
                    df = load(
                        txt_path, fields,
                        ints=[ 'Total Killed', 'Total Injured', 'Pedestrians Killed', 'Pedestrians Injured', 'Total Vehicles Involved', ],
                        floats=[ 'Latitude', 'Longitude', ('MilePost' if v2017 else 'Mile Post')],
                        bools=[ 'Alcohol Involved', 'HazMat Involved', ],
                    )
                    df['Date'] = df.apply(build_dt, axis=1)
                    df = df.drop(columns=['Year', 'Crash Time', 'Crash Date', 'Crash Day Of Week'])
                    if v2017:
                        df = df.rename(columns={
                            'Police Dept Code': 'Police Department Code',
                            'MilePost': 'Mile Post',
                            'SRI (Std Rte Identifier)': 'SRI (Standard Route Identifier)',
                            'Directn From Cross Street': 'Direction From Cross Street',
                        })
                        if year >= 2021:
                            df['County Name'] = df['County Name'].str.upper().str.replace('CAPEMAY', 'CAPE MAY')

                        # Fix 2023 records with empty municipality names
                        # These can't be handled by harmonize nb's majority voting since there's no name to vote on
                        if year == 2023 and region == 'NewJersey':
                            # Assign fake codes to Port Authority crashes (cc=0, mc=0)
                            # These are on GWB and Lincoln Tunnel - outside NJ boundaries but legitimate crash records
                            port_authority_mask = (df['County Code'] == '00') & (df['Municipality Code'] == '00')
                            if port_authority_mask.any():
                                num_pa = port_authority_mask.sum()
                                pa_locs = df.loc[port_authority_mask, 'Crash Location'].str.upper()

                                # Map based on known location patterns:
                                # - GWB: "BRDGE", "I-95"
                                # - Lincoln Tunnel: "TUNNEL", "495", "TUBE", "JFK BLVD", "CLIFTON TERRACE"
                                is_gwb = pa_locs.str.contains('BRDGE|I-95', regex=True, na=False)
                                is_lincoln = pa_locs.str.contains('TUNNEL|495|TUBE|JFK BLVD|CLIFTON TERRACE', regex=True, na=False)

                                # Verify all PA crashes match known patterns
                                unknown_mask = port_authority_mask & ~is_gwb & ~is_lincoln
                                if unknown_mask.any():
                                    unknown_locs = df.loc[unknown_mask, 'Crash Location'].tolist()
                                    raise ValueError(f"Unknown PA crash location(s): {unknown_locs}")

                                # Assign fake codes: cc=99, mc=01 for GWB, mc=02 for Lincoln
                                df.loc[port_authority_mask, 'County Code'] = '99'
                                df.loc[port_authority_mask, 'County Name'] = 'PORT AUTHORITY'
                                df.loc[port_authority_mask & is_gwb, 'Municipality Code'] = '01'
                                df.loc[port_authority_mask & is_gwb, 'Municipality Name'] = 'GWB'
                                df.loc[port_authority_mask & is_lincoln, 'Municipality Code'] = '02'
                                df.loc[port_authority_mask & is_lincoln, 'Municipality Name'] = 'LINCOLN TUNNEL'

                                num_gwb = is_gwb.sum()
                                num_lincoln = is_lincoln.sum()
                                err(f"Assigned fake codes to {num_pa} Port Authority crashes: {num_gwb} GWB (cc=99, mc=01), {num_lincoln} Lincoln Tunnel (cc=99, mc=02)")

                            # Geocode records with empty municipality names using lat/lon
                            empty_mn_mask = df['Municipality Name'].str.strip() == ''
                            if empty_mn_mask.any():
                                from geopandas import GeoDataFrame, points_from_xy, sjoin
                                from nj_crashes.muni_codes import load_munis_geojson

                                empty_mn = df[empty_mn_mask].copy()
                                err(f"Geocoding {len(empty_mn)} records with empty municipality names")

                                # Create GeoDataFrame from lat/lon (WGS84 / EPSG:4326)
                                # Note: Longitude is already negative in NJ, no need to negate
                                empty_mn['geometry'] = points_from_xy(x=empty_mn['Longitude'], y=empty_mn['Latitude'])
                                gdf = GeoDataFrame(empty_mn, geometry='geometry', crs='EPSG:4326')

                                # Load NJGIN municipality boundaries and reproject to match
                                muni_geojson = load_munis_geojson().reset_index()
                                muni_geojson = muni_geojson.to_crs('EPSG:4326')

                                # Spatial join to find municipality
                                joined = sjoin(gdf[['geometry']], muni_geojson[['cc', 'mc', 'COUNTY', 'NAME', 'geometry']], how='left')

                                # Update df with geocoded values
                                num_fixed = 0
                                for idx, row in joined.iterrows():
                                    if pd.notna(row['cc']) and pd.notna(row['mc']):
                                        df.loc[idx, 'County Code'] = str(int(row['cc'])).zfill(2)
                                        df.loc[idx, 'County Name'] = row['COUNTY'].upper()
                                        df.loc[idx, 'Municipality Code'] = str(int(row['mc'])).zfill(2)
                                        df.loc[idx, 'Municipality Name'] = row['NAME'].upper()
                                        num_fixed += 1

                                if num_fixed > 0:
                                    err(f"Fixed {num_fixed} records with empty municipality names via geocoding")
                                if num_fixed < len(empty_mn):
                                    err(f"Warning: {len(empty_mn) - num_fixed} records could not be geocoded (missing or invalid lat/lon)")
                elif typ == 'Vehicles':
                    if year >= 2023:
                        new_fields = get_2023_vehicles_fix_fields(fields, year)
                    else:
                        new_fields = fields
                    df = load(txt_path, new_fields, bools=[ 'Hit & Run Driver Flag', ])
                    # Validate 2023: Extra Model field chars should be spaces, HazMat Placard omitted
                    if year >= 2023:
                        # Verify Model field doesn't use the extra 10 chars (positions 89-98 should be spaces)
                        # This verification would require reading raw file, skip for now
                        err(f"✓ Using adjusted schema for 2023 Vehicles (Model +10 chars, HazMat Placard omitted)")
                    if not v2017:
                        df = df.rename(columns={
                            'Pre- Crash Action': 'Pre-Crash Action',
                        })
                elif typ == 'Pedestrians':
                    if year >= 2021:
                        new_fields = get_2021_dob_fix_fields(fields, 'Date of Birth', year)
                    else:
                        new_fields = fields
                    df = load(txt_path, new_fields, bools=[ 'Is Bycyclist?', 'Is Other?', ]).rename(columns={'Is Bycyclist?': 'Is Bicyclist?'})
                    # Validate 2021-2022: DOB field should be all spaces
                    if 2021 <= year < 2023 and 'Date of Birth' in df.columns:
                        non_empty_dob = df[df['Date of Birth'].str.strip() != '']
                        if len(non_empty_dob) > 0:
                            raise RuntimeError(f"Expected 'Date of Birth' to be all spaces for year {year}, but found {len(non_empty_dob)} non-empty values: {non_empty_dob['Date of Birth'].unique()[:10]}")
                        err(f"✓ Verified 'Date of Birth' field is all spaces ({len(df)} records)")
                    if v2017:
                        df = df.rename(columns={
                            'Type of Most Severe Phys Injury': 'Type of Most Severe Physical Injury',
                        })
                    else:
                        df = df.rename(columns={
                            'Charge': 'Charge 1',
                            'Summons': 'Summons 1',
                            'Physical Status': 'Physical Status 1',
                            'Pre- Crash Action': 'Pre-Crash Action',
                        })
                elif typ == 'Drivers':
                    if year >= 2021:
                        new_fields = get_2021_dob_fix_fields(fields, 'Driver DOB', year)
                    else:
                        new_fields = fields
                    df = load(txt_path, new_fields)
                    # Validate 2021-2022: DOB field should be all spaces
                    if 2021 <= year < 2023 and 'Driver DOB' in df.columns:
                        non_empty_dob = df[df['Driver DOB'].str.strip() != '']
                        if len(non_empty_dob) > 0:
                            raise RuntimeError(f"Expected 'Driver DOB' to be all spaces for year {year}, but found {len(non_empty_dob)} non-empty values: {non_empty_dob['Driver DOB'].unique()[:10]}")
                        err(f"✓ Verified 'Driver DOB' field is all spaces ({len(df)} records)")
                    if not v2017:
                        df = df.rename(columns={
                            'Charge': 'Charge 1',
                            'Summons': 'Summons 1',
                            'Driver Physical Status': 'Driver Physical Status 1',
                        })
                elif typ == 'Occupants':
                    df = load(txt_path, fields)
                    if v2017:
                        df = df.rename(columns={
                            'Type of Most Severe Phys Injury': 'Type of Most Severe Physical Injury',
                        })
                else:
                    raise ValueError(f"Unrecognized type {typ}")

                err(f'Writing {pqt_path}')
                df.to_parquet(pqt_path, index=False)
