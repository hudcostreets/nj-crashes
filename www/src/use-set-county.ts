import { useRouter } from "next/router";
import { useCallback } from "react";
import { normalize } from "@/src/county";

export default function useSetCounty(prefix: string) {
    const router = useRouter()
    const setCounty = useCallback(
        (county: string | null) => {
            router.push(`${prefix}/${county ? normalize(county) : ""}`)
        },
        [router]
    )
    return setCounty
}
