-- `crashes-feedback` D1 database: user "report an issue" submissions
-- (`POST /v1/feedback`, see `src/feedback/handler.ts`).
--
-- Kept out of the data DBs on purpose: `scripts/d1-import.sh` drops and
-- recreates those wholesale.
--
-- Apply:
--   cd api && ../infra/hccs-run npx wrangler d1 migrations apply crashes-feedback --remote
--   cd api && npx wrangler d1 migrations apply crashes-feedback --local   # wrangler dev
CREATE TABLE IF NOT EXISTS feedback (
    id               TEXT    PRIMARY KEY,         -- UUIDv4
    created_at       TEXT    NOT NULL,            -- ISO8601 (server clock)
    comment          TEXT    NOT NULL,
    email            TEXT,                        -- optional, user-supplied
    url              TEXT    NOT NULL,            -- full page URL incl. query
    path             TEXT    NOT NULL,            -- pathname + search, for grouping
    vp_w             INTEGER NOT NULL,
    vp_h             INTEGER NOT NULL,
    dpr              REAL    NOT NULL,
    ua               TEXT    NOT NULL,
    theme            TEXT    NOT NULL,            -- setting: light / dark / system
    actual_theme     TEXT    NOT NULL,            -- resolved: light / dark
    build_sha        TEXT,
    tz               TEXT,
    client_ts        INTEGER NOT NULL,            -- client clock at submit (epoch ms)
    actions          TEXT    NOT NULL,            -- JSON [{t, kind, label}], oldest first
    screenshot_key   TEXT,                        -- R2 key in `crashes-feedback`
    screenshot_type  TEXT,
    screenshot_bytes INTEGER,
    token            TEXT    NOT NULL,            -- unguessable screenshot-link token
    ip_hash          TEXT    NOT NULL,            -- truncated SHA-256; rate limiting only
    country          TEXT,
    slack            TEXT,                        -- sent / skipped / error <status>
    status           TEXT    NOT NULL DEFAULT 'new'
);

CREATE INDEX IF NOT EXISTS feedback_created_at ON feedback (created_at DESC);
CREATE INDEX IF NOT EXISTS feedback_ip_created ON feedback (ip_hash, created_at);
