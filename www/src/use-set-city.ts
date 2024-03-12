import { useRouter } from "next/router";
import { useCallback } from "react";
import { normalize } from "@/src/county";

export default function useSetCity({ prefix, county, }: { prefix: string, county: string }) {
    const router = useRouter()
    const setCity = useCallback(
        (city: string) => {
            router.push(`${prefix}/${county}/${normalize(city)}`)
        },
        [router]
    )
    return setCity
}
