import type { GetStaticProps } from "next";
import { getUrls } from "@/src/urls";
import { loadProps } from "@/server/njsp/plot";
import RegionPage, { Props as RegionProps } from "@/src/region-page";
import * as Njsp from "@/src/njsp/plot";
import { cc2mc2mn } from "@/server/county";

export type Props = Omit<RegionProps, 'title' | 'barProps' | 'Counties'> & { barProps: Njsp.Props }

export const getStaticProps: GetStaticProps<Props> = async () => {
    const urls = getUrls()
    const barProps = await loadProps({ county: null })
    return { props: { urls, barProps, cc2mc2mn } }
}

export default function StatePage({ urls, barProps, cc2mc2mn, }: Props) {
    return (
        <RegionPage
            urls={urls}
            barProps={barProps}
            cc2mc2mn={cc2mc2mn}
            title={`NJ`}
            Counties={barProps.Counties}
        />
    )
}
