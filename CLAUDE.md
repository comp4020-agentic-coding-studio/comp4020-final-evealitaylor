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
- All persistent state lives in the single SQLite file on the `/data`
  volume (`src/db.ts`). No second datastore, no separate DB server — the
  infra is fixed to one `shared-cpu-1x` machine and one volume.
- No accounts: identity is a self-chosen name/pseudonym only, not persisted
  server-side as a profile. Don't add login/auth without that being a
  discussed scope change.

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

## Authorship boundary

`README.md`, `PROCESS.md`, and `reflections/*.md` are personal, student-
authored documents per the course brief — an agent may help find sources,
check citations, or spot gaps in the argument, but must not write their
prose. App code, `CLAUDE.md`, and `spec/` are fair game for an agent to
write and edit directly.
