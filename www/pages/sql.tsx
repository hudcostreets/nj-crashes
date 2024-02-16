import dynamic from "next/dynamic";

const Sql = dynamic(() => import("@/src/sql-repl"), { ssr: false });

export default function SqlPage() {
    return <Sql />
}
