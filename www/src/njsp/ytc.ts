
export const ytcQuery = ({ county, target }: { county: string | null, target: string }) => `
    SELECT
        year,
        CAST(sum(driver) as INT) as driver,
        CAST(sum(pedestrian) as INT) as pedestrian,
        CAST(sum(cyclist) as INT) as cyclist,
        CAST(sum(passenger) as INT) as passenger,
        CAST(sum(driver + pedestrian + cyclist + passenger) as INT) as total,
        NULL as projected
    FROM ${target}
    ${county ? `WHERE county = '${county}'` : ``}
    GROUP BY year
`
