import { useNavigate } from "react-router-dom";
import { useCallback } from "react";
import { normalize } from "@/src/county";

export default function useSetCity({ prefix, county, }: { prefix: string, county: string }) {
    const navigate = useNavigate()
    const setCity = useCallback(
        (city: string) => {
            navigate(`${prefix}/${county}/${normalize(city)}`)
        },
        [navigate, prefix, county]
    )
    return setCity
}
