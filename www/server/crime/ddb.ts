import { DDB } from "@/server/ddb"
import { urls } from "@/src/urls"

export const Homicides = new DDB(urls.crime.homicides)
export const CountyHomicides = new DDB(urls.crime.county_homicides)
