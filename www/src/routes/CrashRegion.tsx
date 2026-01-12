import { useParams } from "react-router-dom"
import { Head } from "@/src/lib/head"
import { url } from "@/src/site"

export default function CrashRegion() {
    const { county, city } = useParams<{ county?: string; city?: string }>()
    const location = city ? `${city}, ${county} County` : county ? `${county} County` : "New Jersey"
    const title = `${location} - Crash Data`

    return (
        <div className="container">
            <Head
                title={title}
                description="NJDOT crash data"
                url={url}
            />
            <main>
                <h1>{title}</h1>
                <p>Crash data visualization (coming soon)</p>
                <a href="/">Back to Home</a>
            </main>
        </div>
    )
}
