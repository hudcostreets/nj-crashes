import { useParams } from "react-router-dom"
import { Head } from "@/src/lib/head"
import { url } from "@/src/site"

export default function NjspRegion() {
    const { county } = useParams<{ county?: string }>()
    const title = county ? `${county} County - NJSP Fatal Crashes` : "NJ Fatal Crashes - NJSP Data"

    return (
        <div className="container">
            <Head
                title={title}
                description="NJ State Police fatal crash data"
                url={url}
            />
            <main>
                <h1>{title}</h1>
                <p>NJSP fatal crash data visualization (coming soon)</p>
                <a href="/">Back to Home</a>
            </main>
        </div>
    )
}
