import React from "react"
import css from "./icons.module.scss"
import { CSSProperties } from "react";

// [Driver](https://thenounproject.com/icon/driver-1847797/) by Musmellow from https://thenounproject.com/browse/icons/term/driver/ Noun Project (CC BY 3.0)
export function Driver({ className, style }: { className?: string, style?: CSSProperties }) {
    return (
        //<span>
            <svg
                xmlns="http://www.w3.org/2000/svg"
                version="1.1"
                x="0px"
                y="0px"
                viewBox="14 5 70 88"
                className={`${css.driver} ${css.icon} ${className ?? ''}`}
                style={style}
            >
                <g transform={`translate(0,12)`}>
                    <path d="M62.3,47.8c-11.7,0-21.1,9.5-21.1,21.1S50.7,90,62.3,90s21.1-9.5,21.1-21.1S74,47.8,62.3,47.8z M49.9,56.5   c3.3-3.3,7.7-5.2,12.4-5.2s9.1,1.8,12.4,5.2c1.1,1.1,2.1,2.4,2.9,3.8L68,64.7c-1.3-1.7-3.3-2.9-5.7-2.9c-2.3,0-4.4,1.1-5.7,2.9   L47,60.2C47.8,58.9,48.7,57.6,49.9,56.5z M59.4,86.2c-3.6-0.6-6.9-2.3-9.5-4.9c-3.3-3.3-5.2-7.7-5.2-12.4c0-1.1,0.1-2.2,0.3-3.2   l10.3,2.8c0,0.1,0,0.3,0,0.4c0,3.2,2.1,5.9,5.1,6.8L59.4,86.2z M58.8,68.9c0-1.9,1.6-3.5,3.5-3.5c1.9,0,3.5,1.6,3.5,3.5   s-1.6,3.5-3.5,3.5C60.4,72.4,58.8,70.8,58.8,68.9z M74.8,81.3c-2.6,2.6-5.9,4.3-9.5,4.9l-0.9-10.6c2.9-0.9,5.1-3.6,5.1-6.8   c0-0.2,0-0.3,0-0.4l10.3-2.8c0.2,1,0.3,2.1,0.3,3.2C79.9,73.6,78.1,78,74.8,81.3z"/>
                    <circle cx="41.2" cy="24.4" r="14.4"/>
                    <path d="M61.9,46.4c-2.4-3.9-5.8-7.1-9.8-9.1c-2.9,2.5-6.7,4-10.8,4c-4.1,0-7.9-1.5-10.8-3.9c-7.9,4.1-13.4,12.3-13.8,22   c0,0,0,8.1,0,8.2c0,3.3,10.6,6,23.7,6.1c-0.3-1.5-0.5-3.1-0.5-4.7C39.8,56.6,49.7,46.6,61.9,46.4z"/>
                </g>
            </svg>
        //</span>
    )
}

// [Passenger](https://thenounproject.com/icon/passenger-4353992/) by Luiz Carvalho from https://thenounproject.com/browse/icons/term/passenger/ Noun Project (CC BY 3.0)
export function Passenger({ className, style }: { className?: string, style?: CSSProperties }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="3 1 26 30"
            className={`${css.passenger} ${css.icon} ${className ?? ''}`}
            style={style}
        >
            <circle cx="17.94653" cy="7.35815" r="5.35815"/>
            <path
                d="M7.8689,20.46265V28.469A1.53531,1.53531,0,0,0,9.39966,30h14.3291L10.3335,16.58936A4.26837,4.26837,0,0,0,7.8689,20.46265Z"/>
            <path
                d="M28.01538,28.469V20.46265A4.27642,4.27642,0,0,0,23.72876,16.176H14.2373L27.60205,29.52539A1.5925,1.5925,0,0,0,28.01538,28.469Z"/>
            <path
                d="M10.80835,16.39038a4.28253,4.28253,0,0,1,1.34692-.21435h2.082l-8.094-8.09424L3.98462,10.24048l6.34888,6.34888A4.42005,4.42005,0,0,1,10.80835,16.39038Z"/>
        </svg>
    )
}
