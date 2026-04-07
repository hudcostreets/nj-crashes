import { Head } from "@/src/lib/head"
import { url } from "@/src/site"

export default function SqlPage() {
    return (
        <div className="container">
            <Head
                title="SQL Query - NJ Crashes"
                description="SQL query interface for NJ crash data"
                url={url}
            />
            <main>
                <h1>SQL Query Interface</h1>
                <p>SQL REPL (coming soon)</p>
                <a href="/">Back to Home</a>
            </main>
        </div>
    )
}
