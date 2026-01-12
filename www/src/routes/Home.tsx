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
import { FatalitiesPerYearPlot } from "@/src/njsp/FatalitiesPerYearPlot"
import { YtdDeathsPlot } from "@/src/njsp/YtdDeathsPlot"
import { HomicidesComparisonPlot } from "@/src/njsp/HomicidesComparisonPlot"
import { FatalitiesPerMonthPlot } from "@/src/njsp/FatalitiesPerMonthPlot"
import { FatalitiesByMonthBarsPlot } from "@/src/njsp/FatalitiesByMonthBarsPlot"
import { PlotContainer } from "@/src/components/PlotContainer"

export default function Home() {
    const basePath = getBasePath()
    const title = "NJ Car Crash Data"

    return (
        <div className={css.container}>
            <Head
                title={title}
                description="Analysis & Visualization of car crash data published by NJ State Police and NJ DOT"
                url={url}
                thumbnail={`${url}/plots/fatalities_per_year_by_type.png`}
            />

            <main className={css.index}>
                <h1 className={css.title}>{title}</h1>
                <p>
                    Exposed and visualized data from two NJ sources:{" "}
                    <A title="NJ State Police fatal crash data" href={NjspFatalAcc}>NJ State Police</A> (fatal crashes, 2008-present, updated daily) and{" "}
                    <A title="NJ DOT raw crash data" href={NjdotRawData}>NJ DOT</A> (all crashes including property-damage and injury, 2001-{EndYear}).
                </p>
                <p>
                    Code and cleaned data are <A href={GitHub.href}>on GitHub</A>.
                </p>

                {/* NJSP Plots */}
                <PlotContainer><FatalitiesPerYearPlot /></PlotContainer>
                <PlotContainer><YtdDeathsPlot /></PlotContainer>
                <PlotContainer><HomicidesComparisonPlot /></PlotContainer>
                <PlotContainer><FatalitiesPerMonthPlot /></PlotContainer>
                <PlotContainer><FatalitiesByMonthBarsPlot /></PlotContainer>

                {/* NJ DOT Section */}
                <h1 id="njdot"><a href="#njdot">NJ DOT Crash Data</a></h1>
                <p>
                    NJ DOT{" "}
                    <A title="NJ DOT raw crash data" href={NjdotRawData}>
                        publishes raw crash data
                    </A>
                    {" "}including property-damage, injury, and fatal crashes, going back to 2001 (≈6MM records, currently through {EndYear}).
                </p>
                <PlotContainer showHr={false}><CrashPlot /></PlotContainer>

                {/* Hudson County Map */}
                <h1 id="map"><a href="#map">Hudson County Crash Map</a></h1>
                <p>
                    5 years (2017-2021) of fatal and injury crashes in Hudson County, plotted from NJ DOT data:
                </p>
                <iframe src={`${basePath}/map/hudson`} className={css.map} title="Hudson County Crash Map" />
                <p style={{ textAlign: 'center' }}>
                    <A href="/map/hudson">Full screen map</A>
                </p>

                <Footer />
            </main>
        </div>
    )
}
