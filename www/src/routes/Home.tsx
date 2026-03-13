import { Head } from "@/src/lib/head"
import { url } from "@/src/site"
import { getBasePath } from "@/src/lib/basePath"
import { NjdotRawData, NjspFatalAcc } from "@/src/urls"
import { GitHub } from "@/src/socials"
import Footer from "@/src/footer"
import A from "@/src/lib/a"
import { EndYear } from "@/src/constants"
import css from "@/src/home.module.scss"
import CrashPlot from "@/src/njdot/CrashPlot"
// import { VictimSeverityPlot } from "@/src/njdot/VictimSeverityPlot"
import { FatalitiesPerYearPlot } from "@/src/njsp/FatalitiesPerYearPlot"
import { YtdDeathsPlot } from "@/src/njsp/YtdDeathsPlot"
import { HomicidesComparisonPlot } from "@/src/njsp/HomicidesComparisonPlot"
import { FatalitiesByMonthBarsPlot } from "@/src/njsp/FatalitiesByMonthBarsPlot"
import { PlotContainer } from "@/src/components/PlotContainer"
import { Breadcrumbs } from "@/src/components/Breadcrumbs"
import { useGeoFilter } from "@/src/GeoFilterContext"
import { normalize } from "@/src/county"
import { Counties } from "@/src/njdot/data"
import { YearStatsSection } from "@/src/tables/YearStatsSection"
import { NjspCrashesSection } from "@/src/tables/NjspCrashesSection"
import { NjdotCrashesSection } from "@/src/tables/NjdotCrashesSection"
import { LazySection } from "@/src/components/LazySection"

export default function Home() {
    const basePath = getBasePath()
    const { cc, mc, countyName, municipalityName } = useGeoFilter()

    // Build title and description based on geo filter
    const regionLabel = municipalityName
        ? `${municipalityName}, ${countyName} County`
        : countyName
            ? `${countyName} County`
            : null
    const title = regionLabel ? `${regionLabel} — NJ Car Crash Data` : "NJ Car Crash Data"
    const description = regionLabel
        ? `Car crash data for ${regionLabel}, NJ`
        : "Analysis & Visualization of car crash data published by NJ State Police and NJ DOT"
    const pageUrl = countyName
        ? municipalityName
            ? `${url}/c/${normalize(countyName)}/${normalize(municipalityName)}`
            : `${url}/c/${normalize(countyName)}`
        : url

    const geo = regionLabel ? ` · ${regionLabel}` : ''

    // Map county code to counties array for CrashPlot
    const countyFilter = cc !== null ? [Number(cc)] : Object.keys(Counties).map(Number)

    return (
        <div className={css.container}>
            <Head
                title={title}
                description={description}
                url={pageUrl}
                thumbnail={`${url}/plots/fatalities_per_year_by_type.png`}
            />

            <main className={css.index}>
                <Breadcrumbs />
                <h1 className={css.title}>{regionLabel ? `${regionLabel} Crash Data` : "NJ Car Crash Data"}</h1>
                {!regionLabel && (
                    <p>
                        Exposed and visualized data from two NJ sources:{" "}
                        <A title="NJ State Police fatal crash data" href={NjspFatalAcc}>NJ State Police</A> (fatal crashes, 2008-present, updated daily) and{" "}
                        <A title="NJ DOT raw crash data" href={NjdotRawData}>NJ DOT</A> (all crashes including property-damage and injury, 2001-{EndYear}).
                    </p>
                )}
                {!regionLabel && (
                    <p>
                        Code and cleaned data are <A href={GitHub.href}>on GitHub</A>.
                    </p>
                )}

                <PlotContainer><FatalitiesPerYearPlot initialCounty={countyName} /></PlotContainer>

                {/* NJSP Fatal Crashes Table */}
                <h2 id="njsp-crashes"><a href="#njsp-crashes">Recent Fatal Crashes (NJSP)</a></h2>
                <div className={css.subtitle}>Fatal crashes, 2008–present{geo}</div>
                <LazySection placeholder={<p>Loading crash data...</p>}>
                    <NjspCrashesSection />
                </LazySection>

                <PlotContainer><YtdDeathsPlot county={countyName} cc={cc} mc={mc} regionLabel={regionLabel} /></PlotContainer>
                {!municipalityName && <PlotContainer><HomicidesComparisonPlot county={countyName} /></PlotContainer>}
                <PlotContainer><FatalitiesByMonthBarsPlot county={countyName} cc={cc} mc={mc} regionLabel={regionLabel} /></PlotContainer>

                {/* NJ DOT Section */}
                <h2 id="njdot"><a href="#njdot">NJ DOT Crash Data</a></h2>
                {regionLabel
                    ? <div className={css.subtitle}>All reported crashes, 2001–{EndYear}{geo}</div>
                    : <p>
                        NJ DOT{" "}
                        <A title="NJ DOT raw crash data" href={NjdotRawData}>
                            publishes raw crash data
                        </A>
                        {" "}including property-damage, injury, and fatal crashes, going back to 2001 (≈6MM records, currently through {EndYear}).
                    </p>
                }
                <PlotContainer showHr={false}><CrashPlot counties={countyFilter} mc={mc} /></PlotContainer>

                {/* Annual Statistics Table (NJ DOT) */}
                <h2 id="stats"><a href="#stats">Annual Statistics (NJ DOT)</a></h2>
                <div className={css.subtitle}>All reported crashes, 2001–{EndYear}{geo}</div>
                <LazySection placeholder={<p>Loading annual statistics...</p>}>
                    <YearStatsSection />
                </LazySection>

                {/* NJDOT Crash Details Table */}
                <h2 id="njdot-crashes"><a href="#njdot-crashes">Crash Details (NJ DOT)</a></h2>
                <div className={css.subtitle}>Injury and fatal crashes, 2001–{EndYear}{geo}</div>
                <LazySection placeholder={<p>Loading crash data...</p>}>
                    <NjdotCrashesSection />
                </LazySection>

                {/* Hudson County Map — only show when not filtered, or when filtered to Hudson */}
                {(!countyName || countyName === "Hudson") && (
                    <>
                        <h2 id="map"><a href="#map">Hudson County Crash Map</a></h2>
                        <p>
                            5 years (2017-2021) of fatal and injury crashes in Hudson County, plotted from NJ DOT data:
                        </p>
                        <iframe src={`${basePath}/map/hudson`} className={css.map} title="Hudson County Crash Map" />
                        <p style={{ textAlign: 'center' }}>
                            <A href="/map/hudson">Full screen map</A>
                        </p>
                    </>
                )}

                <Footer />
            </main>
        </div>
    )
}
