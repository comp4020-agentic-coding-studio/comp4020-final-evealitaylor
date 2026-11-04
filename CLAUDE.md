# CLAUDE.md

Rules for an agent working on this app, derived from decisions already made
about what it is and what "good" means for it. If a change would conflict
with one of these, flag the conflict instead of silently working around it.

## What this app is

A real-time desk-availability board for **Hancock Library, Level 2, only**.
It is not a room-booking tool (ANU already has one) and it does not expand to
other floors or buildings without that being a deliberate, discussed scope
change, not an agent's unilateral call.

Desks are seeded per named zone (`src/seed.ts`) from ANU's public floor plan.
No official document maps individual desk positions, so the seeded count per
zone is an estimate, not a survey — do not present it as verified, and do not
quietly "fix" the count without a crowdsourced-report-driven reason.

## Claims mean "I am here right now"

- Claiming a desk is not a reservation for later. It must be confirmed
  (check-in) within `CHECKIN_GRACE_MS` (`src/logic.ts`, currently 20s) or it
  auto-releases. Do not lengthen this to make check-in "easier" — the short
  window is what makes the claim mean "right now," not a reservation.
- A confirmed (checked-in) claim holds the desk for up to `CLAIM_HOLD_MS`
  (currently 2h) or until released.
- **Invariant: a desk never has two simultaneously live (pending or active)
  claims.** `POST /api/desks/:id/claim` on an already-claimed desk must
  return 409, never silently queue or overwrite. Covered by
  `spec/desk-claims.test.ts`; do not weaken that test to make a feature
  easier to ship.
- **The invariant must hold under concurrent requests, not just sequential
  ones.** In the claim route, never `await` anything (body parsing, QR
  generation, I/O) between checking a desk is free and inserting the claim;
  `insertClaimIfFree` in `src/db.ts` does both synchronously. The partial
  unique index `one_live_claim_per_desk` is the database-level backstop: do
  not drop it, and any new path that creates or revives a claim must go
  through it rather than around it. (Correction: the first version checked
  then awaited the body, and two overlapping requests both got 201.)
- **Only the claimer can check in to or release a claim; this is enforced on
  the server, not by hiding buttons.** Proof is either the claimer's
  signed-in session (the account that made the claim) or the claim token.
  Each claim gets a random claim token
  returned once, in the 201 to the claimer, and in the QR check-in link's
  `#fragment` (which browsers never send to the server). Check-in and release
  both require it (403 otherwise) and refuse a claim that's no longer live
  (409). The token must never appear in `/api/desks`, `/api/activity`, the
  SSE stream, or logs. The token is what lets a phone that scanned the QR
  act on the claim without signing in there too. Anyone may report (free/taken) on any
  desk, by design: reports are observations, not ownership. (Correction: the
  release fix first left check-in open; the two-profile browser check showed
  a second person a working "Check in" button on someone else's claim.)

## History persists; live state expires

- Claims are deliberately short-lived, so the map alone would look empty to
  anyone returning the next day. The `activity` table is the durable record:
  every claim, check-in, release, auto-release (`expire`, with
  `unconfirmed` or `hold-ended`) and report is appended with its timestamp
  and actor's chosen name. **Append-only: never update or delete rows**, and
  every new state-changing route must `record()` its event. Refused actions
  (403/409) record nothing. Covered by `spec/activity-log.test.ts`.
- Each event is also printed to stdout as one JSON line, so `fly logs`
  narrates who did what live. Never log claim tokens.
- The 1s sweep expires both unconfirmed claims and checked-in claims past
  their 2h hold, so both auto-releases reach other sessions and the log.

## Holds up under bad conditions

The marker tests at **1920×1080** and **390×844** in separate Chrome
profiles, with resizes, the keyboard and a slow connection. Any UI change must
keep all of these true. `pnpm check` sees only HTTP, so also run
`pnpm browser-check` (two Chrome profiles, one per viewport, against a running
app; `scripts/browser-check.mjs`) and look at its screenshots before calling a
UI change done:

- No horizontal scroll at either viewport; the desk sheet stays visible when
  resized between them mid-interaction.
- Every desk is reachable by Tab and opened by Enter/Space; Escape closes the
  sheet and returns focus to the desk.
- Action buttons disable while a request is in flight (no double-submits);
  requests time out after 10s with a visible error rather than hanging.
- The server sends an SSE `ping` every 15s; the page treats 35s of silence or
  a browser `offline` event as disconnected, shows "Reconnecting…", and
  reconnects. On reconnect it gets a full snapshot, so changes made while it
  was offline are not lost.

## Crowdsourced reports never overwrite claim status

`POST /api/desks/:id/report` records what someone actually observed
(`free`/`taken`), independent of the claim system. A report must never
silently replace or hide the claim-derived status — a mismatch between
"claimed as occupied" and "reported free" is the product's core insight
(bookings don't always match reality), not a bug to resolve by picking one
side. The UI must surface both signals, not just one.

## Real-time and persistence

- State changes (claim, check-in, release, report, auto-release) must reach
  every open session within about 1 second. The server-side sweep that
  auto-releases expired claims runs on a 1s interval for exactly this reason
  — don't replace it with lazy-on-read-only logic, or auto-release stops
  being something other sessions see happen live.
- **Cost stays flat as history grows.** History is kept forever, so no
  per-request or per-second path may read whole tables: snapshots and the
  sweep read only live claims (`getLiveClaims`) and non-stale reports
  (`getReportsSince`), both indexed. `pnpm bench:history` runs the app on
  50k claims/reports and 100k log rows and must stay under 50ms per
  `/api/desks` and 200MB RSS (the machine has 256MB). Run it after any change
  to `db.ts` queries or the snapshot. (Correction: snapshots originally
  re-read every claim ever made: 450ms and ~390MB at that size, i.e. the
  production machine would have run out of memory as the app was used.)
- All persistent state lives in the single SQLite file on the `/data`
  volume (`src/db.ts`). No second datastore, no separate DB server — the
  infra is fixed to one `shared-cpu-1x` machine and one volume.

## Accounts: anonymous to others, accountable to the system

Accounts were added as a discussed scope change (Nov 2026; previously "no
accounts, pseudonym only"): the audience is ANU students, and the owner
wanted claims tied to a person for record keeping. The rules:

- **Claiming needs an account; reporting never does.** A claim's public name
  is the account's handle. "Looks free/taken" reports need no sign-in and
  are always shown publicly as "Anonymous", even when the reporter is signed
  in (the link is kept privately for their own history). Never put sign-in
  in front of reporting: frictionless honest reports are the product's core.
- **Private fields stay private.** Full name and student ID are stored for
  record keeping and returned only to their owner by `GET /api/me`. They must
  never appear in `/api/desks`, `/api/activity`, the SSE stream, stdout logs,
  error messages, or any other user's response. Covered by
  `spec/accounts.test.ts`; never weaken it.
- **Student IDs are format-checked (`u` + 7 digits), not verified,** and
  deliberately not unique: uniqueness on an unverifiable field would let
  anyone lock a real student out by registering their number first. Never
  present the stored ID as verified.
- **Consent and erasure.** Signup requires explicit consent to the privacy
  notice (`consent: true`). `DELETE /api/me` erases the account (name,
  student ID, passphrase hash, sessions), releases its live claims, and
  replaces the name on its claims. Activity rows are not touched: they store
  a `user_id` and the public log joins to the current handle, so a deleted
  account shows as "deleted user" without breaking the append-only rule.
- **Credentials.** Passphrases: scrypt, per-user salt. Sessions: random
  token in an `HttpOnly; SameSite=Lax` cookie (`Secure` behind https);
  only its SHA-256 is stored. State-changing requests with a cross-site
  `Origin` are refused. No other auth scheme without discussion; never log
  a passphrase, session token or claim token.
- **No ANU single sign-on.** It isn't available to a course app; this is
  why IDs can't be verified. Don't fake it.

## Spec tests

- `spec/invariants.test.ts` is fixed by the course template: never delete,
  weaken, or route around it.
- `spec/logic.test.ts` tests the pure status/expiry functions in
  `src/logic.ts` with injected timestamps — prefer adding cases here over
  wall-clock waiting when a new rule depends on time.
- `spec/auto-release.test.ts` is the one deliberate real-time, real-wait
  end-to-end test. Keep it singular — don't add more wall-clock-waiting
  tests; CI time budget and `CHECKIN_GRACE_MS` were chosen together so this
  one test stays fast.
- **A new test must be shown to fail against the code it guards against**
  before it counts. Run it against the pre-fix commit (e.g. `git show
  HEAD:src/server.ts` into a temp dir) and confirm it goes red. Localhost
  hides network timing, and the first concurrency test (ten parallel
  `fetch`es) passed against the buggy code because each request's body
  arrived with its headers. Concurrency tests must hold the request bodies
  back (send headers, then bodies) to reproduce the real-network interleaving.
- **Every spec test must pass against the deployed app, repeatedly,** not
  just against CI's fresh `/data`. Production persists real claims and an
  append-only log, so tests never hardcode a desk id (use `freeDesk()` from
  `spec/helpers.ts`, with a zone prefix per file since files run in
  parallel), only assert on log events they created (by claim id), release
  every claim they make (`claimDesk`/`track` do this after each test), and
  speak https as well as http. Verify with
  `APP_URL=https://comp4020-final-evealitaylor.fly.dev pnpm test` run twice.
  (Correction: the first live run passed, then a second failed, because it
  found desks still held for 2h by the first run's checked-in claims; the
  race test also crashed on https because `node:http` can't speak it.)
- **Schema changes migrate in place.** The production SQLite file already
  holds data; `src/db.ts` must upgrade an existing database (add columns with
  `ALTER TABLE`, clean up rows that would violate a new constraint) on
  startup, never assume a fresh file or ask anyone to delete `/data`.

## Authorship boundary

`README.md`, `PROCESS.md`, and `reflections/*.md` are personal, student-
authored documents per the course brief — an agent may help find sources,
check citations, or spot gaps in the argument, but must not write their
prose. App code, `CLAUDE.md`, and `spec/` are fair game for an agent to
write and edit directly.
