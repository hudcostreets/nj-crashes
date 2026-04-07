import { AsyncDuckDB } from "@duckdb/duckdb-wasm";
import { TypeCounts } from "@/src/njsp/plot";
import { ProjectedCsv } from "@/src/paths";
import { basename } from "@/src/lib/path";

export type HasDb = {
    db: AsyncDuckDB
}
export type MaybeDb = {
    db: AsyncDuckDB | null
}
export type HasCounty = {
    county: string | null
}
export type Base = HasDb & HasCounty
export type HasCsvText = {
    csvText: string
}
export type DbProps = HasDb & HasCsvText
export type Props = Base & HasCsvText
export type UseProps = MaybeDb & HasCounty & {
    init: TypeCounts
}

export const table = basename(ProjectedCsv)

export const typeCountsQuery = (county: string | null) => `
    SELECT
        CAST(sum(driver) as INT) as driver,
        CAST(sum(pedestrian) as INT) as pedestrian,
        CAST(sum(cyclist) as INT) as cyclist,
        CAST(sum(passenger) as INT) as passenger
    FROM ${table}
    ${county ? `WHERE county = '${county}'` : ``}
`

// export function useTypeProjections({ db, county, init }: UseProps): TypeCounts {
//     const registeredDb = useRegisteredDb({ db, table, url: ProjectedCsv })
//     const [ typeProjections, setTypeProjections ] = useState(init)
//     useEffect(() => {
//         async function get() {
//             console.log("querying projections")
//             if (!registeredDb) return
//             const [ typeProjections ] = await runQuery<TypeCounts>(registeredDb, typeCountsQuery(county))
//             setTypeProjections(typeProjections)
//         }
//         get()
//     }, [ registeredDb, county, ]);
//     return typeProjections
// }
