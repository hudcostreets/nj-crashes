import { Head } from "@/src/lib/head"
import { url } from "@/src/site"

export default function DuckDbPage() {
    return (
        <div className="container">
            <Head
                title="DuckDB - NJ Crashes"
                description="DuckDB interface for NJ crash data"
                url={url}
            />
            <main>
                <h1>DuckDB Interface</h1>
                <p>DuckDB query interface (coming soon)</p>
                <a href="/">Back to Home</a>
            </main>
        </div>
    )
}
