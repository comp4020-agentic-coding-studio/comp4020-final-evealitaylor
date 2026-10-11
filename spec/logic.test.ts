import { describe, expect, it } from "vitest";
import {
  CHECKIN_GRACE_MS,
  CLAIM_HOLD_MS,
  REPORT_STALE_MS,
  activeClaimForDesk,
  computeDeskStatus,
  isClaimExpired,
  isReportStale,
  latestReportForDesk,
  type Claim,
  type OccupancyReport,
} from "../src/logic.ts";

// Pure-function tests: every "has time passed" question here is answered by
// injecting `now` rather than actually waiting, so this stays fast. The one
// true wall-clock test lives in spec/auto-release.test.ts.

function claim(overrides: Partial<Claim>): Claim {
  return {
    id: 1,
    deskId: "desk-1",
    name: "eve",
    startedAt: 0,
    checkedInAt: null,
    expiresAt: CHECKIN_GRACE_MS,
    status: "pending",
    ...overrides,
  };
}

function report(overrides: Partial<OccupancyReport>): OccupancyReport {
  return {
    id: 1,
    deskId: "desk-1",
    status: "free",
    createdAt: 0,
    ...overrides,
  };
}

describe("isClaimExpired", () => {
  it("is false before the deadline", () => {
    const c = claim({ expiresAt: 1000 });
    expect(isClaimExpired(c, 999)).toBe(false);
  });

  it("is true once the deadline has passed", () => {
    const c = claim({ expiresAt: 1000 });
    expect(isClaimExpired(c, 1000)).toBe(true);
    expect(isClaimExpired(c, 1001)).toBe(true);
  });

  it("is false for already-released or already-expired claims", () => {
    expect(isClaimExpired(claim({ expiresAt: 0, status: "released" }), 1_000_000)).toBe(false);
    expect(isClaimExpired(claim({ expiresAt: 0, status: "expired" }), 1_000_000)).toBe(false);
  });
});

describe("isReportStale", () => {
  it("is false within the stale window", () => {
    const r = report({ createdAt: 0 });
    expect(isReportStale(r, REPORT_STALE_MS)).toBe(false);
  });

  it("is true once the stale window has elapsed", () => {
    const r = report({ createdAt: 0 });
    expect(isReportStale(r, REPORT_STALE_MS + 1)).toBe(true);
  });
});

describe("computeDeskStatus / activeClaimForDesk", () => {
  it("is available with no claims", () => {
    expect(computeDeskStatus([], "desk-1", 0)).toBe("available");
    expect(activeClaimForDesk([], "desk-1", 0)).toBeNull();
  });

  it("is pending for an unconfirmed, unexpired claim", () => {
    const claims = [claim({ status: "pending", expiresAt: 1000 })];
    expect(computeDeskStatus(claims, "desk-1", 500)).toBe("pending");
  });

  it("is occupied for a checked-in claim", () => {
    const claims = [claim({ status: "active", expiresAt: CLAIM_HOLD_MS })];
    expect(computeDeskStatus(claims, "desk-1", 500)).toBe("occupied");
  });

  it("is available again once a pending claim's expiry has passed", () => {
    const claims = [claim({ status: "pending", expiresAt: 1000 })];
    expect(computeDeskStatus(claims, "desk-1", 1000)).toBe("available");
  });

  it("ignores released and expired claims, and claims on other desks", () => {
    const claims = [
      claim({ id: 1, deskId: "desk-1", status: "released", expiresAt: 10_000 }),
      claim({ id: 2, deskId: "desk-1", status: "expired", expiresAt: 10_000 }),
      claim({ id: 3, deskId: "desk-2", status: "active", expiresAt: 10_000 }),
    ];
    expect(computeDeskStatus(claims, "desk-1", 0)).toBe("available");
  });
});

describe("latestReportForDesk", () => {
  it("returns null when there are no reports", () => {
    expect(latestReportForDesk([], "desk-1", 0)).toBeNull();
  });

  it("returns the most recent non-stale report for the desk", () => {
    const reports = [
      report({ id: 1, deskId: "desk-1", status: "free", createdAt: 0 }),
      report({ id: 2, deskId: "desk-1", status: "taken", createdAt: 500 }),
      report({ id: 3, deskId: "desk-2", status: "taken", createdAt: 999 }),
    ];
    const latest = latestReportForDesk(reports, "desk-1", 600);
    expect(latest?.id).toBe(2);
  });

  it("ignores stale reports", () => {
    const reports = [report({ createdAt: 0 })];
    expect(latestReportForDesk(reports, "desk-1", REPORT_STALE_MS + 1)).toBeNull();
  });
});
