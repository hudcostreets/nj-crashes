# NJDOT Traffic Crash Data
Work-in-progress analysis of [NJDOT's raw traffic crash data](https://www.state.nj.us/transportation/refdata/accident/rawdata01-current.shtm)

I've only done a very quick first pass at cleaning and plotting the data here, so take these with a grain of salt. The download action on the page above doesn't work, so I had to dig into the source and find the raw `.zip` files directly.

Injuries and "Property Damage" crashes seem to drop precipitously in 2020 in a way that I suspect is a result of data quality issues, or changes in reporting, police staffing, or some other confounders:

![](./injuries_per_month.png)

![](./prop_damage_per_month.png)

One reason I am suspicious is that traffic deaths did not similarly decrease at that time.

![](./deaths_per_month.png)

Additionally, annual death count totals here are ≈10% higher than what's reported in the NJSP data (see [the root of this repository](..)).
