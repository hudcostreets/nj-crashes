import React from 'react'
import type { GetStaticProps } from "next";
import { Props } from "@/src/njsp/plot";
import { loadProps } from "@/server/njsp/plot";
import NjspPlotPage from "@/src/njsp/page";

export const getStaticProps: GetStaticProps<Props> = async () => {
    const props = await loadProps()
    return { props }
}

export default function Page(barProps: Props) {
    return <NjspPlotPage barProps={barProps} county={null} />
}
