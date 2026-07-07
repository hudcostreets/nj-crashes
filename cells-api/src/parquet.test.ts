import { describe, it, expect } from "vitest"
import { readParquetFromR2 } from "./parquet"

/** A bucket whose keys are all absent: `head` and `get` return null. The
 *  `missingOk` path short-circuits on the null head before any parquet
 *  decode, so no real parquet bytes are needed to exercise it. */
const emptyBucket = {
    head: async () => null,
    get: async () => null,
} as unknown as R2Bucket

describe("readParquetFromR2 missing key", () => {
    it("returns [] for a missing key when missingOk is set", async () => {
        const rows = await readParquetFromR2(emptyBucket, "pyramid/s9_r12/absent.parquet", {
            missingOk: true,
        })
        expect(rows).toEqual([])
    })

    it("throws for a missing key by default", async () => {
        await expect(
            readParquetFromR2(emptyBucket, "pyramid/s9_r12/absent.parquet"),
        ).rejects.toThrow("R2 key not found: pyramid/s9_r12/absent.parquet")
    })
})
