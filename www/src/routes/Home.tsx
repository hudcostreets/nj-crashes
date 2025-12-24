import { Head } from "@/src/lib/head"
import { url } from "@/src/site"
import { getBasePath } from "@/src/lib/basePath"
import { NjdotRawData, NjspFatalAcc } from "@/src/urls"
import { GitHub } from "@/src/socials"
import Footer from "@/src/footer"
import A from "@/src/lib/a"
import { EndYear } from "@/src/constants"
import css from "@/src/home.module.scss"
import { plotSpecs } from "@/src/plotSpecs"
import { Plot } from "@/src/lib/plot"
import { Fragment } from "react"

export default function Home() {
    const basePath = getBasePath()
    const title = "NJ Traffic Crash Data"

    // Build menu structure from plot specs
    const sections = plotSpecs.map(({ id, title, menuName, dropdownSection }) => ({
        id,
        name: menuName || title,
        dropdownSection
    }))

    const menus = [
        { id: "NJSP", name: "NJSP" },
        { id: "state-years", name: "State x Years" },
        { id: "county-years", name: "Counties x Years" },
        { id: "state-months", name: "State x Months" },
        { id: "county-months", name: "Counties x Months" },
    ].map(s => ({
        ...s,
        sections: sections.filter(({ dropdownSection }) => s.name === dropdownSection)
    }))

    return (
        <div className={css.container}>
            <Head
                title={title}
                description="Analysis & Visualization of traffic crash data published by NJ State Police and NJ DOT"
                url={url}
                thumbnail={`${url}/plots/fatalities_per_year_by_type.png`}
            />

            <main className={css.index}>
                <h1 className={css.title}>{title}</h1>
                <p>
                    <A href="#per-year">The first {menus[0].sections.length} plots below</A> come from{" "}
                    <A title="NJ State Police fatal crash data" href={NjspFatalAcc}>NJ State Police fatal crash data</A>{" "}
                    (2008-present). It's generally current to the previous day.
                </p>
                <p>
                    <A href="#njdot">Below that</A> are plots of{" "}
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
                {plotSpecs.slice(0, menus[0].sections.length).map(spec => (
                    <div key={spec.id} className={css["plot-container"]}>
                        <Plot
                            {...spec}
                            basePath={basePath}
                            margin={{ t: 10, b: 30 }}
                        />
                        <hr />
                    </div>
                ))}

                {/* NJDOT Section Header */}
                <h1 id="njdot"><a href="#njdot">NJ DOT Raw Crash Data</a></h1>
                <p>
                    NJ DOT{" "}
                    <A title="NJ DOT raw crash data" href={NjdotRawData}>
                        publishes raw crash data
                    </A>
                    , including property-damage, injury, and fatal crashes, going back to 2001 (≈6MM records).
                </p>
                <p>
                    Data is currently public through {EndYear}, showing all crash types rebounding from COVID lows,
                    and a particular spike in fatalities. 2023 data is expected in Fall 2025.
                </p>

                {/* NJDOT Plots */}
                {plotSpecs.slice(menus[0].sections.length).map(spec => (
                    <div key={spec.id} className={css["plot-container"]}>
                        <Plot
                            {...spec}
                            basePath={basePath}
                            margin={{ t: 10, b: 30 }}
                        />
                        <hr />
                    </div>
                ))}

                <Footer />
            </main>
        </div>
    )
}
