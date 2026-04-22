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
import { CrashMapSection } from "@/src/map/CrashMapSection"
// import { VictimSeverityPlot } from "@/src/njdot/VictimSeverityPlot"
import { FatalitiesPerYearPlot } from "@/src/njsp/FatalitiesPerYearPlot"
import { YtdDeathsPlot } from "@/src/njsp/YtdDeathsPlot"
import { HomicidesComparisonPlot } from "@/src/njsp/HomicidesComparisonPlot"
import { FatalitiesByMonthBarsPlot } from "@/src/njsp/FatalitiesByMonthBarsPlot"
import { PlotContainer } from "@/src/components/PlotContainer"
import { GeoNavBar } from "@/src/components/GeoNavBar"
import { useGeoFilter } from "@/src/GeoFilterContext"
import { normalize } from "@/src/county"
import { Counties } from "@/src/njdot/data"
import { YearStatsSection } from "@/src/tables/YearStatsSection"
import { NjspCrashesSection } from "@/src/tables/NjspCrashesSection"
import { NjdotCrashesSection } from "@/src/tables/NjdotCrashesSection"
import { LazySection } from "@/src/components/LazySection"
import { PlotInfo } from "@/src/icons"
import { useEffect } from "react"
import { ResetSoloProvider, useResetAllSolo } from "@/src/lib/ResetSoloContext"

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
        <ResetSoloProvider>
        <HomeInner
            title={title}
            description={description}
            pageUrl={pageUrl}
            regionLabel={regionLabel}
            geo={geo}
            countyName={countyName}
            municipalityName={municipalityName}
            cc={cc}
            mc={mc}
            countyFilter={countyFilter}
            basePath={basePath}
        />
        </ResetSoloProvider>
    )
}

function HomeInner({ title, description, pageUrl, regionLabel, geo, countyName, municipalityName, cc, mc, countyFilter, basePath }: {
    title: string, description: string, pageUrl: string, regionLabel: string | null, geo: string,
    countyName: string | null, municipalityName: string | null,
    cc: number | null, mc: number | null, countyFilter: number[], basePath: string,
}) {
    const resetAll = useResetAllSolo()

    // Document-level click listener so empty page margins (outside the
    // centered `.container`) also reset. Exclude interactive areas.
    useEffect(() => {
        const handler = (e: MouseEvent) => {
            const target = e.target as Element | null
            if (!target) return
            if (target.closest('.legend .traces')) return
            if (target.closest('.trace')) return
            if (target.closest('button, a, select, input, label, summary')) return
            if (target.closest('[class*="iconLegend"], .pltly-legend-row, .pltly-legend-item')) return
            if (target.closest('[class*="controlsContent"]')) return
            if (target.closest('[class*="bodyPanel"]')) return
            resetAll()
        }
        document.addEventListener('click', handler)
        return () => document.removeEventListener('click', handler)
    }, [resetAll])

    return (
        <div className={css.container}>
            <Head
                title={title}
                description={description}
                url={pageUrl}
                thumbnail={`${url}/og.png`}
            />

            <main className={css.index}>
                <GeoNavBar />
                <h1 className={css.title}>{regionLabel ? `${regionLabel} Crash Data` : "NJ Car Crash Data"}</h1>
                {!regionLabel && (
                    <p>
                        Data analysis and visualization from two NJ sources:{" "}
                        <A title="NJ State Police fatal crash data" href={NjspFatalAcc}>NJ State Police</A> (fatal crashes, 2001-present, updated daily) and{" "}
                        <A title="NJ DOT raw crash data" href={NjdotRawData}>NJ DOT</A> (all crashes including property-damage and injury, 2001-{EndYear}).
                    </p>
                )}
                {!regionLabel && (
                    <p>
                        Code and cleaned data are <A href={GitHub.href}>on GitHub</A>.
                    </p>
                )}

                <PlotContainer><FatalitiesPerYearPlot key={`p1-${cc}-${mc}`} initialCounty={countyName} cc={cc} mc={mc} regionLabel={regionLabel} /></PlotContainer>

                {/* NJSP Fatal Crashes Table */}
                <h2 id="njsp-crashes"><a href="#njsp-crashes">Recent Fatal Crashes</a></h2>
                <div className={css.subtitle}>Fatal crashes, 2001–present{geo} <PlotInfo source="njsp" showLegendHint={false} /></div>
                <LazySection placeholder={<p>Loading crash data...</p>}>
                    <NjspCrashesSection key={`njsp-${cc}-${mc}`} />
                </LazySection>

                <PlotContainer><YtdDeathsPlot key={`ytd-${cc}-${mc}`} county={countyName} cc={cc} mc={mc} regionLabel={regionLabel} /></PlotContainer>
                {!municipalityName && <PlotContainer><HomicidesComparisonPlot key={`hom-${countyName}`} county={countyName} cc={cc} /></PlotContainer>}
                <PlotContainer><FatalitiesByMonthBarsPlot key={`fbm-${cc}-${mc}`} county={countyName} cc={cc} mc={mc} regionLabel={regionLabel} /></PlotContainer>

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
                <PlotContainer showHr={false}><CrashPlot key={`dot-${cc}-${mc}`} counties={countyFilter} mc={mc} /></PlotContainer>

                {/* Crash map */}
                <h2 id="map"><a href="#map">Crash Map</a></h2>
                <div className={css.subtitle}>
                    Injury and fatal crashes{geo}{" "}
                    (<a href={`/map${cc !== null ? `/c/${countyName?.toLowerCase().replace(/\s+/g, "-")}${mc !== null && municipalityName ? `/${municipalityName.toLowerCase().replace(/\s+/g, "-")}` : ""}` : ""}`}>open full-screen</a>)
                </div>
                <PlotContainer showHr={false}>
                    <CrashMapSection key={`map-${cc}-${mc}`} cc={cc} mc={mc} height={500} />
                </PlotContainer>

                {/* Annual Statistics Table (NJ DOT) */}
                <h2 id="stats"><a href="#stats">Annual Statistics (NJ DOT)</a></h2>
                <div className={css.subtitle}>All reported crashes, 2001–{EndYear}{geo}</div>
                <LazySection placeholder={<p>Loading annual statistics...</p>}>
                    <YearStatsSection key={`stats-${cc}-${mc}`} />
                </LazySection>

                {/* NJDOT Crash Details Table */}
                <h2 id="njdot-crashes"><a href="#njdot-crashes">Crash Details (NJ DOT)</a></h2>
                <div className={css.subtitle}>Injury and fatal crashes, 2001–{EndYear}{geo}</div>
                <LazySection placeholder={<p>Loading crash data...</p>}>
                    <NjdotCrashesSection key={`njdot-${cc}-${mc}`} />
                </LazySection>

                <Footer />
            </main>
        </div>
    )
}
