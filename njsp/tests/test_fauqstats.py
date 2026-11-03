"""`FAUQStats` parsing: crash `dt`s, including wall-clock times around DST transitions."""
from njsp.fauqstats import FAUQStats


def _xml(*crashes: tuple[str, str, str]) -> bytes:
    accidents = '\n'.join(
        f'<ACCIDENT ACCID="{accid}" DATE="{date}" TIME="{time}"><FATALITIES>1</FATALITIES></ACCIDENT>'
        for accid, date, time in crashes
    )
    return f'''<?xml version="1.0" encoding="utf-8"?>
<!-- Fatal Crash statistics -->
<FAUQSTATS>
  <RUNDATE>Tue Nov 03 10:00:02 EST 2026</RUNDATE>
  <STATSYEAR>2026</STATSYEAR>
  <COUNTY CCODE="13" CNAME="Monmouth">
    <MUNICIPALITY MCODE="1316" MNAME="Freehold Twsp">
{accidents}
    </MUNICIPALITY>
  </COUNTY>
  <TOTACCIDENTS>{len(crashes)}</TOTACCIDENTS>
  <TOTINJURIES>0</TOTINJURIES>
  <TOTFATALITIES>{len(crashes)}</TOTFATALITIES>
</FAUQSTATS>
'''.encode()


def _dts(*crashes: tuple[str, str, str]) -> dict[str, str]:
    df = FAUQStats.parse_bytes(_xml(*crashes), None).crashes
    return {accid: dt.isoformat() for accid, dt in df['dt'].items()}


def test_ordinary_times():
    assert _dts(
        ('1', '10/31/2026', '2359'),
        ('2', '11/02/2026', '0108'),
    ) == {
        '1': '2026-10-31T23:59:00-04:00',
        '2': '2026-11-02T01:08:00-05:00',
    }


def test_fall_back_hour_resolves_to_dst():
    """01:00–01:59 occurs twice on fall-back day, and NJSP's `TIME` doesn't say which. Assume the
    first (EDT). Regression: ACCID 14894 (2026-11-01 01:08) raised `AmbiguousTimeError` in `harmonize`."""
    assert _dts(
        ('14894', '11/01/2026', '0108'),
        ('2', '11/01/2026', '0059'),
        ('3', '11/01/2026', '0200'),
    ) == {
        '2': '2026-11-01T00:59:00-04:00',
        '14894': '2026-11-01T01:08:00-04:00',
        '3': '2026-11-01T02:00:00-05:00',
    }


def test_spring_forward_gap_shifts_forward():
    """02:00–02:59 doesn't exist on spring-forward day; such a `TIME` becomes 03:00 EDT."""
    assert _dts(
        ('1', '03/08/2026', '0230'),
        ('2', '03/08/2026', '0300'),
    ) == {
        '1': '2026-03-08T03:00:00-04:00',
        '2': '2026-03-08T03:00:00-04:00',
    }
