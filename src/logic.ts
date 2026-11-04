// Pure, no-I/O desk-status logic. Kept separate from db.ts/server.ts so it
// can be unit tested with injected timestamps instead of real elapsed time.

// Claiming a desk means "I am here right now": a short confirm window, not a
// reservation window. That's a product choice (see README/PROCESS), and it's
// also what keeps the auto-release spec test fast.
export const CHECKIN_GRACE_MS = 20_000;
// Once checked in, a desk is held for up to this long before it's expected
// to be released (manually, via "I'm leaving", or just by convention).
export const CLAIM_HOLD_MS = 2 * 60 * 60 * 1000;
// A crowdsourced "actually free/taken" report fades out after this long.
export const REPORT_STALE_MS = 15 * 60 * 1000;

export type ClaimStatus = "pending" | "active" | "released" | "expired";

export interface Desk {
  id: string;
  zone: string;
  label: string;
}

export interface Claim {
  id: number;
  deskId: string;
  name: string;
  startedAt: number;
  checkedInAt: number | null;
  expiresAt: number;
  status: ClaimStatus;
  // The account that made it; null for claims from before accounts existed.
  userId: number | null;
}

export type ReportStatus = "free" | "taken";

export interface OccupancyReport {
  id: number;
  deskId: string;
  status: ReportStatus;
  createdAt: number;
}

export type DeskStatus = "available" | "pending" | "occupied";

// One line of the who-did-what history. "expire" is the server's 1s sweep
// auto-releasing a claim; its actor is the claim's owner, not the system.
export type ActivityKind = "claim" | "checkin" | "release" | "expire" | "report";

export interface ActivityEvent {
  id: number;
  at: number;
  kind: ActivityKind;
  deskId: string;
  claimId: number | null;
  actor: string;
  // report: "free" | "taken"; expire: "unconfirmed" | "hold-ended"
  detail: string | null;
}

export function isClaimExpired(claim: Claim, now: number): boolean {
  if (claim.status === "released" || claim.status === "expired") return false;
  return claim.expiresAt <= now;
}

export function isReportStale(report: OccupancyReport, now: number): boolean {
  return now - report.createdAt > REPORT_STALE_MS;
}

// The most recent still-live claim on a desk, or null if it's free.
export function activeClaimForDesk(
  claims: Claim[],
  deskId: string,
  now: number,
): Claim | null {
  const live = claims
    .filter((c) => c.deskId === deskId)
    .filter((c) => c.status === "pending" || c.status === "active")
    .filter((c) => !isClaimExpired(c, now))
    .sort((a, b) => b.startedAt - a.startedAt);
  return live[0] ?? null;
}

export function computeDeskStatus(
  claims: Claim[],
  deskId: string,
  now: number,
): DeskStatus {
  const claim = activeClaimForDesk(claims, deskId, now);
  if (!claim) return "available";
  return claim.status === "active" ? "occupied" : "pending";
}

// The freshest non-stale crowdsourced report, surfaced alongside claim
// status rather than replacing it — a mismatch between the two is the point.
export function latestReportForDesk(
  reports: OccupancyReport[],
  deskId: string,
  now: number,
): OccupancyReport | null {
  const live = reports
    .filter((r) => r.deskId === deskId)
    .filter((r) => !isReportStale(r, now))
    .sort((a, b) => b.createdAt - a.createdAt);
  return live[0] ?? null;
}

// ---- Ghost claims: the product's core insight, counted ----
//
// A ghost claim is a "looks free" report made while that desk was claimed
// (pending) or checked in: the booking says taken, someone there says
// otherwise. Counted from the activity log alone, by replaying each desk's
// events in order, so it needs no extra state and covers all history.

export interface GhostTally {
  // "Looks free" reports that landed on a live claim.
  ghosts: number;
  // Every report in the window, for context ("4 of 11 reports").
  reports: number;
  // Claims made in the window.
  claims: number;
  byZone: Record<string, number>;
}

export function tallyGhosts(
  events: ActivityEvent[],
  zoneOf: (deskId: string) => string,
  since: number,
): GhostTally {
  const tally: GhostTally = { ghosts: 0, reports: 0, claims: 0, byZone: {} };
  // Desk id -> whether a claim is currently open on it, replaying in order.
  const open = new Map<string, boolean>();
  const ordered = [...events].sort((a, b) => a.id - b.id);
  for (const e of ordered) {
    if (e.kind === "claim") open.set(e.deskId, true);
    else if (e.kind === "release" || e.kind === "expire") open.set(e.deskId, false);
    if (e.at < since) continue;
    if (e.kind === "claim") tally.claims++;
    if (e.kind !== "report") continue;
    tally.reports++;
    if (e.detail === "free" && open.get(e.deskId)) {
      tally.ghosts++;
      const zone = zoneOf(e.deskId);
      tally.byZone[zone] = (tally.byZone[zone] ?? 0) + 1;
    }
  }
  return tally;
}

// Midnight in Canberra (where the library is), as a UTC timestamp, for "today".
export function startOfLibraryDay(now: number, timeZone = "Australia/Sydney"): number {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(now));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const sinceMidnight = ((get("hour") * 60 + get("minute")) * 60 + get("second")) * 1000 + (now % 1000);
  return now - sinceMidnight;
}
