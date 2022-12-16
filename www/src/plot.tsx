import {HasTotals, PlotSpec} from "./plotSpecs";
import React, {useState} from "react";
import styles from "../styles/Home.module.css";
import index from "../pages/index.module.css";
import Image from "next/image";
import dynamic from "next/dynamic";
import {PlotParams} from "react-plotly.js";
import {Margin} from "plotly.js";
const Plotly = dynamic(() => import("react-plotly.js"), { ssr: false })

export type Plot = PlotSpec & {
    plot: PlotParams
    title: string
    margin?: Partial<Margin>
} & HasTotals & { basePath: string, rundate: string, }

export const DEFAULT_MARGIN = { t: 0, r: 15, b: 0, l: 0 }

export function Plot({ id, title, subtitle, plot, margin, basePath, rundate, src, children, projectedTotals }: Plot) {
    const [ initialized, setInitialized ] = useState(false)
    const {
        data,
        layout: {
            title: plotTitle, margin: plotMargin, xaxis, yaxis,
            ...rest
        },
        style
    } = plot
    const plotTitleText = typeof plotTitle == 'string' ? plotTitle : plotTitle?.text
    const renderedSubtitle = subtitle instanceof Function ? subtitle({ title: plotTitleText, projectedTotals, rundate }) : subtitle
    const renderedChildren = children instanceof Function ? children({ title: plotTitleText, projectedTotals, rundate }) : children
    const height = style?.height || 450
    margin = { ...DEFAULT_MARGIN, ...plotMargin, ...margin }
    return (
        <div id={id} key={id} className={styles["plot-body"]}>
            <h2><a href={`#${id}`}>{title}</a></h2>
            {renderedSubtitle}
            <Plotly
                onInitialized={() => { setInitialized(true) }}
                className={styles.plot}
                data={data}
                layout={{
                    margin,
                    ...(xaxis ? { xaxis } : {}),
                    yaxis,
                    autosize: true,
                    dragmode: false,
                    ...rest
                }}
                config={{ displayModeBar: false, scrollZoom: false, }}
                style={{ ...style, display: initialized ? "" : "none", width: "100%" }}
                // onClick={() => setInitialized(false)}
            />
            {
                src &&
                <div className={`${index.fallback} ${initialized ? index.hidden : ""}`} style={{ height: `${height}px`, maxHeight: `${height}px` }}>
                    <Image
                        alt={title}
                        src={`${basePath}/${src}`}
                        width={800} height={height}
                        // layout="responsive"
                        loading="lazy"
                        // onClick={() => setInitialized(true)}
                    />
                    <div className={index.spinner}></div>
                </div>
            }
            {renderedChildren}
        </div>
    )
}
