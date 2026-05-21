# Live NJSP fatalities feed

**Motivation.** The safe26 deck's "Killed" counter ticks from a hardcoded
`start-value=177 @ 2026-05-14` baseline. That was eyeballed off the local
`data/FAUQStats2026.xml` — `<TOTFATALITIES>177</TOTFATALITIES>`, RUNDATE
`Wed May 13 10:00:01 EDT 2026`. Three problems surface from that:

1. **Staleness.** Daily refresh runs at 15:30 UTC, but the local copy was
   ~2 days old when the deck was authored (5/15 vs. RUNDATE 5/13). Either
   the GHA didn't run, or it ran and didn't actually pull a fresh upstream
   XML. Worth verifying which.

2. **No machine-readable summary endpoint.** A presenter / external deck /
   embed wants "what's the current YTD fatality count for NJ?" — answering
   that today requires fetching the raw XML, parsing it client-side, and
   summing `<TOTFATALITIES>` (or counting `<ACCIDENT>` entries). Nothing
   stops us from emitting a tiny static `summary.json` keyed by year +
   county as part of the daily refresh.

3. **`/raw/njsp/data/` listing reports as "incomplete".** Reporter says the
   directory listing at `https://crashes.hudcostreets.org/raw/njsp/data/`
   doesn't show what they expected. Need to compare what `RawFileBrowser`
   surfaces vs. what's actually in the R2/S3 bucket. Possible causes:
   pagination, filter UI hiding `.dvc` files but also hiding the data file,
   permissions on a parent prefix, or an actual sync gap.

## Scope (sketch)

### 1. Verify refresh actually fetches upstream

- Check the last few `daily.yml` runs (`.github/workflows/daily.yml`,
  scheduled 15:30 UTC) — are they succeeding? Does the NJSP XML actually
  change between runs? `njsp.cli.refresh_data.update_xml_dvc` is the path.
- If the refresh is content-addressed and skips on no-change, that's fine —
  but the `RUNDATE` inside the XML should still advance daily even when
  NJ's data hasn't changed materially. If it doesn't, NJSP's own upstream
  hasn't been pinged.

### 2. Emit `summary.json` per year

Daily DVX stage that reads `FAUQStats<YYYY>.xml` and emits
`data/njsp/summary/<YYYY>.json`:

```json
{
  "year": 2026,
  "rundate": "2026-05-13T14:00:01Z",
  "state": { "fatalities": 177, "accidents": 169, "injuries": 12345 },
  "counties": {
    "Hudson":   { "fatalities":  12, "accidents":  11, "injuries":  234 },
    "Bergen":   { "fatalities":  18, "accidents":  17, "injuries":  456 },
    ...
  }
}
```

- Publish at a stable URL like `https://crashes.hudcostreets.org/njsp/summary/2026.json`.
- CORS-open so decks / embeds can fetch directly.
- Cache headers: ~1h `Cache-Control: public, max-age=3600` is fine — refresh
  cadence is daily.
- Keep it small (~few hundred bytes). No need to ship the full XML through
  a CF Worker.

### 3. (Optional) Bump refresh cadence

Daily is fine for slides/embeds. **Don't** poll NJ's site more aggressively
without checking their robots/usage norms first — this is small-state data
maintained by humans, not a public API. If freshness matters for a specific
event (e.g. running a deck the day after a high-profile crash), `workflow_dispatch`
with the `force` input already exists.

### 4. Investigate `/raw/njsp/data/` listing

- Reproduce the "looks incomplete" complaint: load the URL and compare to
  `aws s3 ls` (or wrangler r2) on the underlying bucket prefix.
- Likely candidates: `RawFileBrowser` / `DirListing` filter UI, parent
  prefix that filters out non-leaf entries, or a real bucket-sync gap from
  the daily pipeline.

## Out of scope

- NJDOT (NJTR-1) refresh — that's annual, separate pipeline.
- AASHTOWare integration — that has its own portal + ingest flow.

## Decks that will consume this

- safe26 — replace the hardcoded `start-value` on the "Killed" `TickingCounter`
  with a fetch of `summary/2026.json` at mount time. Fall back to baked
  value if fetch fails (so OG generation doesn't depend on network).
- Probably others in HCCS deck collection over time.

## References

- Source XML schema: `<FAUQSTATS>` → `<COUNTY>` × N → `<ACCIDENT>` × N with
  `<TOTFATALITIES>`, `<TOTACCIDENTS>`, `<TOTINJURIES>` per county +
  state-level totals on the parent.
- Daily pipeline: `.github/workflows/daily.yml` → `njsp.cli.refresh_data`.
- Web raw browser: `www/src/raw/{RawFileBrowser,DirListing}.tsx`.
- Authored by: claude (safe26 session 2026-05-15), prompted by user
  noticing the "is it 179 or 177?" discrepancy in the deck's counter.
