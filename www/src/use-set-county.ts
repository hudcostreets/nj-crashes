import { useNavigate } from "react-router-dom";
import { useCallback } from "react";
import { normalize } from "@/src/county";

export default function useSetCounty(prefix: string) {
    const navigate = useNavigate()
    const setCounty = useCallback(
        (county: string | null) => {
            navigate(`${prefix}/${county ? normalize(county) : ""}`)
        },
        [navigate, prefix]
    )
    return setCounty
}
