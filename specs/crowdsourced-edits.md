# Crowdsourced edits with review queue

## Motivation

Several in-flight specs describe surfaces where readers know things the
data doesn't, and where their input would measurably improve the
product:

- `specs/page-annotations.md` — geo/plot-level notes (Alpine 2013-2018,
  Bridgeton 2018-2020, …)
- `specs/njsp-njdot-fatal-harmonization.md` — per-pass match residuals;
  readers who know a specific crash can manually link the NJSP and
  NJDOT records for it
- `specs/crash-detail-pages.md` — news links, Bluesky/Slack thread
  references for individual crashes

All three converge on the same plumbing: **a logged-in reader should
be able to suggest an edit, a moderator should approve it, and
approved edits should land in the site's source of truth** (ideally a
PR against the repo).

The hard constraints:
1. It must be easy — email-link or OAuth, not a whole account flow.
2. **No unmoderated writes to the live site.** Everything is a
   suggestion until a human approves it.
3. The moderation queue should be lightweight and live where I
   already operate — default: Slack.

## Edit types

The mechanism is generic but initially serves three shapes:

| Surface | Edit shape | PK/scope |
|---------|-----------|----------|
| Annotation | Propose/edit a geo-scoped note | `(cc?, mc?, page?, year_range?)` |
| Harmonization residual | "These two rows are the same crash" (optional note) | `(njsp_id, njdot_pk)` pair |
| Crash detail | Add news URL / Bluesky link / photo / correction | `crash_pk` |

Each edit carries `{ kind, payload, author_email, submitted_at,
source_url }` plus a freeform `note` explaining the submitter's
reasoning.

## Lifecycle

```
  reader clicks "Suggest an edit" on some page
     └─> auth via magic email link (or OAuth-lite)
         └─> submits typed form, validates client-side
             └─> POST to Cloudflare Worker → Queue row
                  └─> Slack notification (channel: #crash-edits)
                       with Approve / Reject buttons
                       └─> On approve:
                            - append to `edits/<kind>/<id>.md` in repo
                              via GitHub API (Worker-held PAT)
                            - open/update an "open edits" PR
                            - next deploy picks up the change
                       └─> On reject:
                            - write to `rejected.log` with reason
                            - notify submitter (optional)
```

### Data stores

- **Pending queue** (per-edit row while awaiting review): D1 table or
  KV; whatever Cloudflare gives us cheap durability.
- **Approved edits** (authoritative): committed Markdown/YAML files
  under `edits/` in the repo. This keeps the source of truth in git;
  the site renders from the files after each deploy. No live DB of
  user content that can drift from the repo.
- **Rejected / dupes**: one-line log, kept only for debugging/abuse
  detection.

### Auth

Keep it simple:
- **v1**: magic-link email (send a 10-minute JWT via Cloudflare Email).
  Rate-limit to a handful of submissions per email per day.
- **v2** (optional): GitHub OAuth — reader signs in with the account
  that will be credited in the eventual commit.
- **v3** (aspirational): Bluesky / ATProto auth, so identity carries
  over from the public discussion on the crash posts.

### Abuse protection

- Turnstile (Cloudflare's captcha) on the submit endpoint.
- Per-email and per-IP rate limits.
- Hard-cap on pending queue size; reject further submissions with a
  "try again later" message if the queue is backed up.
- Slack review step is the ultimate gate: nothing lands without an
  explicit ✅ from me.

## Phasing

Nothing here needs to be built at once. Staging:

1. **Phase 0 (now)**: draft schema + PR-template variants for each
   edit kind. Submitters fork/PR manually; I merge.
2. **Phase 1**: form endpoint + Slack notifications, but approved
   edits still create a PR (not a direct commit) so review happens
   in GitHub's UI. Email-link auth.
3. **Phase 2**: in-place approve-from-Slack (buttons that trigger
   a PR merge via a Worker).
4. **Phase 3**: GitHub / Bluesky OAuth; richer per-edit UI.

Phases 1-3 are additive; if we stop at phase 1 the product still has
crowdsourced data cleanup, just with a PR-review step instead of a
Slack-button flow.

## Relationship to other specs

- **`specs/page-annotations.md`**: the annotation authoring flow
  should use this mechanism once phase 1 lands. Until then,
  annotations are PR-only.
- **`specs/njsp-njdot-fatal-harmonization.md`**: side-by-side
  residuals page (NJSP-only rows on the left, NJDOT-only on the
  right) gains an "I think these two are the same" pairing affordance
  that feeds this queue.
- **`specs/crash-detail-pages.md`**: "Add a reference" button on
  each detail page submits a `crash_detail_ref` edit.

## Open questions

- **Source of truth for approved edits**: Markdown files in the repo
  vs. a D1 table? Files are diffable, version-controlled, and
  portable; D1 is faster to query. Defaulting to files, with an index
  built at build time.
- **Attribution**: credit authors by email/handle on rendered
  annotations? Probably yes for annotations (they're quasi-public
  contributions); for harmonization pairings, maybe aggregate as
  "community-verified" without per-edit attribution.
- **Privacy**: does a user who submits a news link to a fatal crash
  want their email attached? Probably: store only a hashed identifier
  unless the submitter opts in to credit.

## Out of scope

- Full discussion threads / comments under each annotation (that's
  what the Bluesky mirror is for).
- Site-wide user profiles beyond "you have an email / OAuth identity
  that's submitted N approved edits".
