import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SEED_DESKS } from "./seed.ts";
import type {
  ActivityEvent,
  ActivityKind,
  Claim,
  ClaimStatus,
  Desk,
  OccupancyReport,
  ReportStatus,
} from "./logic.ts";

// Fly's one volume is mounted at /data; override for local dev with
// DB_PATH=./some/local/file.db since /data won't exist outside the container.
const DB_PATH = process.env.DB_PATH ?? "/data/app.db";
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS desks (
    id TEXT PRIMARY KEY,
    zone TEXT NOT NULL,
    label TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    desk_id TEXT NOT NULL,
    name TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    checked_in_at INTEGER,
    expires_at INTEGER NOT NULL,
    status TEXT NOT NULL
  );
  -- Append-only history of who did what: never updated or deleted, so it's
  -- what persists across days after every claim has long since expired.
  CREATE TABLE IF NOT EXISTS activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    desk_id TEXT NOT NULL,
    claim_id INTEGER,
    actor TEXT NOT NULL,
    detail TEXT
  );
  CREATE TABLE IF NOT EXISTS occupancy_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    desk_id TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

// Claim token: a secret handed only to whoever made the claim, so nobody
// else can check in to or free their desk. Added after launch, so older rows have none.
const claimColumns = db.prepare("PRAGMA table_info(claims)").all() as { name: string }[];
if (!claimColumns.some((c) => c.name === "token")) {
  db.exec("ALTER TABLE claims ADD COLUMN token TEXT");
}

// The database itself refuses a second live claim on a desk, as a backstop
// to the check in the claim route. Any duplicates left from before the index
// existed are expired first (newest wins) so creating it can't fail.
db.exec(`
  UPDATE claims SET status = 'expired'
  WHERE status IN ('pending', 'active')
    AND id NOT IN (
      SELECT MAX(id) FROM claims WHERE status IN ('pending', 'active') GROUP BY desk_id
    );
  CREATE UNIQUE INDEX IF NOT EXISTS one_live_claim_per_desk
    ON claims (desk_id) WHERE status IN ('pending', 'active');
`);

const deskCount = db.prepare("SELECT COUNT(*) AS n FROM desks").get() as { n: number };
if (deskCount.n === 0) {
  const insert = db.prepare("INSERT INTO desks (id, zone, label) VALUES (?, ?, ?)");
  for (const desk of SEED_DESKS) {
    insert.run(desk.id, desk.zone, desk.label);
  }
}

interface ClaimRow {
  id: number;
  desk_id: string;
  name: string;
  started_at: number;
  checked_in_at: number | null;
  expires_at: number;
  status: ClaimStatus;
  token: string | null;
}

interface ReportRow {
  id: number;
  desk_id: string;
  status: ReportStatus;
  created_at: number;
}

function claimFromRow(row: ClaimRow): Claim {
  return {
    id: row.id,
    deskId: row.desk_id,
    name: row.name,
    startedAt: row.started_at,
    checkedInAt: row.checked_in_at,
    expiresAt: row.expires_at,
    status: row.status,
  };
}

function reportFromRow(row: ReportRow): OccupancyReport {
  return {
    id: row.id,
    deskId: row.desk_id,
    status: row.status,
    createdAt: row.created_at,
  };
}

export function getDesks(): Desk[] {
  const rows = db.prepare("SELECT id, zone, label FROM desks ORDER BY id").all() as unknown as Desk[];
  return rows;
}

export function getClaims(): Claim[] {
  const rows = db.prepare("SELECT * FROM claims").all() as unknown as ClaimRow[];
  return rows.map(claimFromRow);
}

export function getClaim(id: number): Claim | null {
  const row = db.prepare("SELECT * FROM claims WHERE id = ?").get(id) as unknown as ClaimRow | undefined;
  return row ? claimFromRow(row) : null;
}

export function getReports(): OccupancyReport[] {
  const rows = db.prepare("SELECT * FROM occupancy_reports").all() as unknown as ReportRow[];
  return rows.map(reportFromRow);
}

// Inserts a pending claim, or returns null if the desk already has a live
// one. Claims whose time has run out but that the 1s sweep hasn't reached yet
// are expired first, so they can't block a new claim via the unique index.
export function insertClaimIfFree(
  deskId: string,
  name: string,
  token: string,
  startedAt: number,
  expiresAt: number,
): Claim | null {
  db.prepare(
    "UPDATE claims SET status = 'expired' WHERE desk_id = ? AND status IN ('pending', 'active') AND expires_at <= ?",
  ).run(deskId, startedAt);
  try {
    const result = db
      .prepare(
        "INSERT INTO claims (desk_id, name, started_at, checked_in_at, expires_at, status, token) VALUES (?, ?, ?, NULL, ?, 'pending', ?)",
      )
      .run(deskId, name, startedAt, expiresAt, token);
    return {
      id: Number(result.lastInsertRowid),
      deskId,
      name,
      startedAt,
      checkedInAt: null,
      expiresAt,
      status: "pending",
    };
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint failed/.test(err.message)) return null;
    throw err;
  }
}

export function getClaimToken(id: number): string | null {
  const row = db.prepare("SELECT token FROM claims WHERE id = ?").get(id) as { token: string | null } | undefined;
  return row?.token ?? null;
}

export function markCheckedIn(id: number, checkedInAt: number, expiresAt: number): void {
  db.prepare(
    "UPDATE claims SET status = 'active', checked_in_at = ?, expires_at = ? WHERE id = ?",
  ).run(checkedInAt, expiresAt, id);
}

export function markReleased(id: number): void {
  db.prepare("UPDATE claims SET status = 'released' WHERE id = ?").run(id);
}

export function markExpired(id: number): void {
  db.prepare("UPDATE claims SET status = 'expired' WHERE id = ?").run(id);
}

export function insertReport(deskId: string, status: ReportStatus, createdAt: number): void {
  db.prepare("INSERT INTO occupancy_reports (desk_id, status, created_at) VALUES (?, ?, ?)").run(
    deskId,
    status,
    createdAt,
  );
}

interface ActivityRow {
  id: number;
  at: number;
  kind: ActivityKind;
  desk_id: string;
  claim_id: number | null;
  actor: string;
  detail: string | null;
}

export function insertActivity(event: Omit<ActivityEvent, "id">): ActivityEvent {
  const result = db
    .prepare("INSERT INTO activity (at, kind, desk_id, claim_id, actor, detail) VALUES (?, ?, ?, ?, ?, ?)")
    .run(event.at, event.kind, event.deskId, event.claimId, event.actor, event.detail);
  return { id: Number(result.lastInsertRowid), ...event };
}

// Newest first.
export function getActivity(limit: number): ActivityEvent[] {
  const rows = db
    .prepare("SELECT * FROM activity ORDER BY id DESC LIMIT ?")
    .all(limit) as unknown as ActivityRow[];
  return rows.map((row) => ({
    id: row.id,
    at: row.at,
    kind: row.kind,
    deskId: row.desk_id,
    claimId: row.claim_id,
    actor: row.actor,
    detail: row.detail,
  }));
}
