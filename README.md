# NJ Traffic Violence Data
Analysis of NJ State Police traffic violence data (2008-present): https://nj.gov/njsp/info/fatalacc/index.shtml

### Traffic deaths are 1.5x-2x homicides

![](./fatalities_vs_homicides_per_year.png)

**Traffic deaths spiked by 19% in 2021.**

### Last half of 2021 was the 6 worst months on record:

![](./fatalities_by_month_lines.png)

### Victim types: drivers > pedestrians > passengers > cyclists

![](./fatalities_per_month_by_type.png)

This data is available starting from 2020.

---

## Data / Info

### Data sources:
- New Jersey State Police
  - Traffic fatalities: https://nj.gov/njsp/info/fatalacc/index.shtml
  - Uniform Crime Reports: https://nj.gov/njsp/ucr/uniform-crime-reports.shtml
- Disaster Center: https://www.disastercenter.com/crime/njcrimn.htm

### Analysis
- [parse-njsp-xmls.ipynb](./parse-njsp-xmls.ipynb)
- [nj-crime-stats.ipynb](./nj-crime-stats.ipynb)

---

## Appendix

A few more plots:

#### Month groups, as bars

![](./fatalities_by_month_bars.png)

#### Monthly history w/ 12mo rolling avg

![](./fatalities_per_month.png)

### "Victim type" subtotals
Victim type data is only available starting since 2020, so most history is unknown:

![](./fatalities_per_year_by_type.png)
