-- `tune` D1 database — picker-tuning preference votes from `/tune/ab`.
--
-- Apply:
--   cd cells-api && pnpm exec wrangler d1 execute tune --remote --file sql/tune.sql
--
-- Columns are flat (not a JSON blob) so the corpus is queryable in SQL —
-- the whole point of using a DB over the JSONL this replaced. `cfg` stays
-- JSON: it's a snapshot of whatever `tuning.json` held at vote time, whose
-- shape evolves with the picker.
CREATE TABLE IF NOT EXISTS picker_votes (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    ts             TEXT    NOT NULL,           -- ISO8601, vote time
    edited_ts      TEXT,                       -- ISO8601, last in-place edit
    -- Voter identity. NULL = the local dev/admin voter (today's only
    -- case). Reserved for $oa/auth logins once others can participate.
    voter          TEXT,
    -- View + picker features (what a learner conditions on).
    view           TEXT    NOT NULL,
    lat            REAL    NOT NULL,
    lon            REAL    NOT NULL,
    zoom           REAL    NOT NULL,
    vp_w           INTEGER NOT NULL,
    vp_h           INTEGER NOT NULL,
    scope_km2      REAL,                       -- NULL = statewide (viewport-budgeted)
    mppx           REAL    NOT NULL,
    area_px        INTEGER NOT NULL,           -- clip-share-budgeted area
    auto_target_px REAL    NOT NULL,
    cfg            TEXT    NOT NULL,           -- JSON snapshot of shipped tuning
    prod           INTEGER NOT NULL,           -- level the shipped picker chose
    -- Per-side rendered level + measured cost.
    l_level        INTEGER NOT NULL,
    l_bins         INTEGER,
    l_body         INTEGER,
    l_wire         INTEGER,
    l_ms           INTEGER,
    r_level        INTEGER NOT NULL,
    r_bins         INTEGER,
    r_body         INTEGER,
    r_wire         INTEGER,
    r_ms           INTEGER,
    -- Verdict. `choice` ∈ (left, right, tie, finer, coarser); `finer`/
    -- `coarser` mean "neither — the sweet spot is outside this pair".
    choice         TEXT    NOT NULL,
    chosen         INTEGER,                    -- level chosen; NULL unless left/right
    note           TEXT    NOT NULL DEFAULT ''
);

-- History panel reads newest-first; analyses group by view.
CREATE INDEX IF NOT EXISTS picker_votes_ts ON picker_votes (ts DESC);
CREATE INDEX IF NOT EXISTS picker_votes_view ON picker_votes (view);
