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
