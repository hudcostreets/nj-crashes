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
                    <A href="#per-year">The first 5 plots below</A> come from{" "}
                    <A title="NJ State Police fatal crash data" href={NjspFatalAcc}>NJ State Police fatal crash data</A>{" "}
                    (2008-present). It's generally current to the previous day.
                </p>
                <p>
                    <A href="#njdot">Below that</A> is an interactive plot of{" "}
                    <A title="NJ DOT raw crash data" href={NjdotRawData}>NJ DOT raw crash data</A>,{" "}
                    which includes 6MM property-damage, injury, and fatal crashes from 2001-{EndYear}.
                    It's a richer dataset, but less up to date.
                </p>
                <p>
                    <span className={css.bold}>Work in progress</span> map of NJDOT data: 5 years (2017-2021) of fatal
                    and injury crashes in Hudson County:
                </p>
                <iframe src={`${basePath}/map/hudson`} className={css.map} title="Hudson County Crash Map" />
                <ul style={{ listStyle: "none", padding: 0 }}>
                    <li><A href="/map/hudson">Full screen map here</A></li>
                    <li>Code and cleaned data are <A href={GitHub.href}>here on GitHub</A>.</li>
                </ul>

                {/* NJSP Plots */}
                <PlotContainer><FatalitiesPerYearPlot /></PlotContainer>
                <PlotContainer><YtdDeathsPlot /></PlotContainer>
                <PlotContainer><HomicidesComparisonPlot /></PlotContainer>
                <PlotContainer><FatalitiesPerMonthPlot /></PlotContainer>
                <PlotContainer><FatalitiesByMonthBarsPlot /></PlotContainer>

                {/* NJDOT Section */}
                <h1 id="njdot"><a href="#njdot">NJ DOT Crash Data</a></h1>

                <PlotContainer showHr={false}><CrashPlot /></PlotContainer>
                <p>
                    NJ DOT{" "}
                    <A title="NJ DOT raw crash data" href={NjdotRawData}>
                        publishes raw crash data
                    </A>
                    , including property-damage, injury, and fatal crashes, going back to 2001 (≈6MM records).
                </p>
                <p>
                    Data is currently public through {EndYear}. Use the controls above to explore
                    crashes by severity, time period, and geography.
                </p>

                <Footer />
            </main>
        </div>
    )
}
