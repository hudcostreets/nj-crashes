from bs4 import BeautifulSoup as bs
import pandas as pd


def get_children(tag):
    return [ child for child in tag.children if not isinstance(child, str) ]


def parse_file(path):
    with open(path, 'r') as f:
        xml = bs(f, features="xml")
    children = list(xml.children)
    assert len(children) == 2
    fauqstats = children[-1]
    assert fauqstats.name == 'FAUQSTATS', fauqstats.name
    rundate = fauqstats.RUNDATE.text
    year = int(fauqstats.STATSYEAR.text)
    counties = fauqstats.find_all('COUNTY', recursive=False)
    total_accidents = int(fauqstats.TOTACCIDENTS.text)
    total_injuries = int(fauqstats.TOTINJURIES.text)
    total_fatalities = int(fauqstats.TOTFATALITIES.text)
    crash_counties = [ county for county in counties if county.MUNICIPALITY ]
    print(f'{len(counties)} "COUNTY" entries, {len(crash_counties)} containing "MUNICIPALITY"/crash info, {total_accidents} accidents, {total_injuries} injuries, {total_fatalities} fatalities')
    records = []
    for county in crash_counties:
        municipalities = county.find_all('MUNICIPALITY')
        for municipality in municipalities:
            assert municipality.name == 'MUNICIPALITY'
            children = get_children(municipality)
            accidents = municipality.find_all('ACCIDENT', recursive=False)
            if len(children) != len(accidents):
                raise ValueError(f'Found {len(children)} municipality children, but {len(accidents)} accidents: {county}. {accidents}')
            for accident in accidents:
                obj = { child.name: child.text for child in get_children(accident) }
                obj = dict(**county.attrs, **municipality.attrs, **accident.attrs, **obj, )
                records.append(obj)

    df = pd.DataFrame(records)
    totals_df = pd.DataFrame([dict(
        year=year,
        accidents=total_accidents,
        injuries=total_injuries,
        fatalities=total_fatalities,
    )])
    return dict(crashes=df, totals=totals_df, rundate=rundate)


def normalized_ytd_days(dt):
    """Combine 2/29 and 2/28, count YTD days as if in non-leap years."""
    days = int((dt - pd.to_datetime(f'{dt.year}').tz_localize(dt.tz)).days + 1)
    if dt.year % 4 == 0 and dt.month >= 3:
        days -= 1
    return days


if __name__ == '__main__':
    result = parse_file('data/FAUQStats2023.xml')
    print(result)
