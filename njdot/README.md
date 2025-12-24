# NJDOT Traffic Crash Data
Analysis of [NJDOT traffic crash data](https://www.state.nj.us/transportation/refdata/accident/rawdata01-current.shtm).

[**Plots**](#plots):
  - [Crashes per Month (Statewide)](#state-month)
      - [Injuries per Month (Statewide)](#state-month-injuries)
      - [Property Damage Crashes per Month (Statewide)](#state-month-crashes)
      - [Deaths per Month (Statewide)](#state-month-deaths)
  - [Crashes per {County, Month}](#counties-month)
      - [Injuries per {County, Month}](#counties-month-injuries)
      - [Property Damage Crashes per {County, Month}](#counties-month-crashes)
      - [Deaths per {County, Month}](#counties-month-deaths)
  - [Crashes per Year (Statewide)](#state-year)
      - [Injuries per Year (Statewide)](#state-year-injuries)
      - [Property Damage Crashes per Year (Statewide)](#state-year-crashes)
      - [Deaths per Year (Statewide)](#state-year-deaths)
  - [Crashes per {County, Year}](#counties-year)
      - [Injuries per {County, Year}](#counties-year-injuries)
      - [Property Damage Crashes per {County, Year}](#counties-year-crashes)
      - [Deaths per {County, Year}](#counties-year-deaths)
  - [Crash-Type Percentages](#pcts)
      - [Injuries, Property Damage, Deaths (as Percentage of All Crashes)](#pcts-all)
      - [Deaths (as Percentage of All Crashes)](#pct-deaths)

[**Methods**](#methods):
  - [Example: Download + Clean Data](#example)
  - [Caveats / TODOs](#todos)


## Plots <a id="plots"></a>
I've only done a very quick first pass at cleaning and plotting the data here, so take these with a grain of salt.

There is a marked decrease in "injury" and "property damage" crashes since the onset of COVID (≈March 2020), but fatal crashes are roughly flat:

### Crashes per Month (Statewide) <a id="state-month"></a>

#### Injuries per Month (Statewide) <a id="state-month-injuries"></a>
![](../www/public/plots/njdot/ism.png)

#### Property Damage Crashes per Month (Statewide) <a id="state-month-crashes"></a>
![](../www/public/plots/njdot/psm.png)

#### Deaths per Month (Statewide) <a id="state-month-deaths"></a>
![](../www/public/plots/njdot/dsm.png)

### Crashes per {County, Month} <a id="counties-month"></a>

#### Injuries per {County, Month} <a id="counties-month-injuries"></a>
![](../www/public/plots/njdot/icm.png)

#### Property Damage Crashes per {County, Month} <a id="counties-month-crashes"></a>
![](../www/public/plots/njdot/pcm.png)

#### Deaths per {County, Month} <a id="counties-month-deaths"></a>
![](../www/public/plots/njdot/dcm.png)

### Crashes per Year (Statewide) <a id="state-year"></a>

#### Injuries per Year (Statewide) <a id="state-year-injuries"></a>
![](../www/public/plots/njdot/isy.png)

#### Property Damage Crashes per Year (Statewide) <a id="state-year-crashes"></a>
![](../www/public/plots/njdot/psy.png)

#### Deaths per Year (Statewide) <a id="state-year-deaths"></a>
![](../www/public/plots/njdot/dsy.png)

### Crashes per {County, Year} <a id="counties-year"></a>

#### Injuries per {County, Year} <a id="counties-year-injuries"></a>
![](../www/public/plots/njdot/icy.png)

#### Property Damage Crashes per {County, Year} <a id="counties-year-crashes"></a>
![](../www/public/plots/njdot/pcy.png)

#### Deaths per {County, Year} <a id="counties-year-deaths"></a>
![](../www/public/plots/njdot/dcy.png)

### Crash-Type Percentages <a id="pcts"></a>

#### Injuries, Property Damage, Deaths (as Percentage of All Crashes) <a id="pcts-all"></a>
![](../www/public/plots/njdot/pcts_by_type_month.png)

#### Deaths (as Percentage of All Crashes) <a id="pct-deaths"></a>
![](../www/public/plots/njdot/pct_fatal_by_month.png)

## Methods <a id="methods"></a>
[`rawdata.py`](rawdata.py) is a CLI for downloading+caching `.zip`s, extracting `.txt`s, cleaning+converting to `.pqt` ([Parquet](https://parquet.apache.org/)).
```bash
./rawdata.py --help
# Usage: rawdata.py [OPTIONS] COMMAND [ARGS]...
# 
# Options:
#   --help  Show this message and exit.
# 
# Commands:
#   check-nj-agg      For one or more years, verify the `NewJersey` file is a
#                     concatenation of the county-specific files
#   parse-fields-pdf  Parse fields+lengths from one of the `*CrashTable.pdf`s,
#                     using Tabula
#   pqt               Convert 1 or more unzipped {year, county} `.txt` files to
#                     `.pqt`s, with some dtypes and cleanup
#   txt               Convert 1 or more {year, county} .zip files (convert each
#                     .zip to a single .txt)
#   zip               Download 1 or more {year, county} .zip file(s)
```

### Example: Download + Clean Data <a id="example"></a>
```bash
./rawdata.py zip -r NewJersey  # download statewide-aggregated `.zip`s for [2001,2020] x {Accidents,Drivers,Occupants,Pedestrians,Vehicles}
./rawdata.py txt -r NewJersey  # Extract each `.zip` (to a single `.txt`)
./rawdata.py pqt -r NewJersey  # Clean (parse dates, assign some dtypes) + convert to Parquet
```

### Notebooks <a id="notebooks"></a>
- [crash-plots.ipynb](crash-plots.ipynb): load all crashes, generate plots above

### SQLite DBs
```bash
njdot compute pqt -f
njdot compute db -f
```

[cmymc.ipynb](cmymc.ipynb): generate [cmymc.db](../www/public/njdot/cmymc.db.dvc) containing several {**c**ounty, **m**uni, **y**ear, **m**onth} aggregation tables.

### Caveats / TODOs <a id="todos"></a>

The fatal crash stats here also seem to differ from NJSP's data (see [the root of this repository](..)) by ≈10%.

---

### Attributions:
- [Driver](https://thenounproject.com/icon/driver-1847797/) by Musmellow from <a href="https://thenounproject.com/browse/icons/term/driver/" target="_blank" title="Driver Icons">Noun Project</a> (CC BY 3.0)
- [Passenger](https://thenounproject.com/icon/passenger-4353992/) by Luiz Carvalho from <a href="https://thenounproject.com/browse/icons/term/passenger/" target="_blank" title="passenger Icons">Noun Project</a> (CC BY 3.0)
- [Pedestrian](https://thenounproject.com/icon/pedestrian-1826968/) by Adrien Coquet from <a href="https://thenounproject.com/browse/icons/term/pedestrian/" target="_blank" title="Pedestrian Icons">Noun Project</a> (CC BY 3.0)
- [Bicycle](https://thenounproject.com/icon/bicycle-1311416/) by Adrien Coquet from <a href="https://thenounproject.com/browse/icons/term/bicycle/" target="_blank" title="Bicycle Icons">Noun Project</a> (CC BY 3.0)
- [Car](https://thenounproject.com/icon/car-6583503/) by Nur syifa fauziah from <a href="https://thenounproject.com/browse/icons/term/car/" target="_blank" title="Car Icons">Noun Project</a> (CC BY 3.0)
- [Person](https://thenounproject.com/icon/person-6627610/) by Rini Bahtiar from <a href="https://thenounproject.com/browse/icons/term/person/" target="_blank" title="person Icons">Noun Project</a> (CC BY 3.0)

**TODO:** add to www pages
