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

// Accounts. Other users only ever see `handle`; full name and student ID are
// returned only to their owner (GET /api/me) and never logged or broadcast.
// student_id is deliberately NOT unique: it can't be verified, so making it
// unique would let anyone lock a real student out by registering their
// number first.
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    handle TEXT NOT NULL UNIQUE COLLATE NOCASE,
    full_name TEXT NOT NULL,
    student_id TEXT NOT NULL,
    pass_hash TEXT NOT NULL,
    consented_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
`);

// Adds a column to a table that predates it (production already has data).
function addColumn(table: string, column: string, type: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

// Who did it, when signed in. Null on rows from before accounts and on
// anonymous reports. The log shows the user's *current* handle (or "deleted
// user"), so deleting an account never rewrites a log row.
addColumn("claims", "user_id", "INTEGER");
addColumn("occupancy_reports", "user_id", "INTEGER");
addColumn("activity", "user_id", "INTEGER");

// Claim token: a secret handed only to whoever made the claim, so nobody
// else can check in to or free their desk. Added after launch, so older rows have none.
addColumn("claims", "token", "TEXT");

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

// Reads only ever ask for live claims and recent reports, never the whole
// history, so these keep snapshot and sweep cost flat as history grows.
db.exec(`
  CREATE INDEX IF NOT EXISTS claims_live ON claims (status) WHERE status IN ('pending', 'active');
  CREATE INDEX IF NOT EXISTS reports_recent ON occupancy_reports (created_at);
  CREATE INDEX IF NOT EXISTS claims_by_user ON claims (user_id);
  CREATE INDEX IF NOT EXISTS activity_by_user ON activity (user_id);
  CREATE INDEX IF NOT EXISTS sessions_by_user ON sessions (user_id);
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
  user_id: number | null;
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
    userId: row.user_id,
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

// Only pending/active claims: everything the snapshot and sweep need. The
// full history stays in the table (and the activity log) but is never
// scanned per request; that's what kept this app from scaling (see CLAUDE.md).
export function getLiveClaims(): Claim[] {
  const rows = db
    .prepare("SELECT * FROM claims WHERE status IN ('pending', 'active')")
    .all() as unknown as ClaimRow[];
  return rows.map(claimFromRow);
}

export function getClaim(id: number): Claim | null {
  const row = db.prepare("SELECT * FROM claims WHERE id = ?").get(id) as unknown as ClaimRow | undefined;
  return row ? claimFromRow(row) : null;
}

// Reports created at or after `since`; older ones are stale and never shown.
export function getReportsSince(since: number): OccupancyReport[] {
  const rows = db
    .prepare("SELECT * FROM occupancy_reports WHERE created_at >= ?")
    .all(since) as unknown as ReportRow[];
  return rows.map(reportFromRow);
}

// Inserts a pending claim, or returns null if the desk already has a live
// one. Claims whose time has run out but that the 1s sweep hasn't reached yet
// are expired first, so they can't block a new claim via the unique index.
export function insertClaimIfFree(
  deskId: string,
  userId: number,
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
        "INSERT INTO claims (desk_id, name, started_at, checked_in_at, expires_at, status, token, user_id) VALUES (?, ?, ?, NULL, ?, 'pending', ?, ?)",
      )
      .run(deskId, name, startedAt, expiresAt, token, userId);
    return {
      id: Number(result.lastInsertRowid),
      deskId,
      name,
      startedAt,
      checkedInAt: null,
      expiresAt,
      status: "pending",
      userId,
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

export function insertReport(deskId: string, status: ReportStatus, createdAt: number, userId: number | null): void {
  db.prepare("INSERT INTO occupancy_reports (desk_id, status, created_at, user_id) VALUES (?, ?, ?, ?)").run(
    deskId,
    status,
    createdAt,
    userId,
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
  user_id: number | null;
  // Joined from users: the current handle, or null if the account is gone.
  handle: string | null;
}

// What's stored: `actor` is the public name at the time (a handle, or
// "Anonymous" for reports); `userId` links it to an account when there is one.
export function insertActivity(event: Omit<ActivityEvent, "id">, userId: number | null): ActivityEvent {
  const result = db
    .prepare("INSERT INTO activity (at, kind, desk_id, claim_id, actor, detail, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(event.at, event.kind, event.deskId, event.claimId, event.actor, event.detail, userId);
  return { id: Number(result.lastInsertRowid), ...event };
}

function activityFromRow(row: ActivityRow): ActivityEvent {
  return {
    id: row.id,
    at: row.at,
    kind: row.kind,
    deskId: row.desk_id,
    claimId: row.claim_id,
    // A signed-in actor shows as their current handle; once their account is
    // deleted, as "deleted user". Rows without a user keep what was stored.
    actor: row.user_id === null ? row.actor : (row.handle ?? "deleted user"),
    detail: row.detail,
  };
}

// Public log, newest first. Reports are always shown as "Anonymous" here,
// even when the reporter was signed in: the link is kept privately for the
// reporter's own history only.
export function getActivity(limit: number): ActivityEvent[] {
  const rows = db
    .prepare(
      `SELECT a.*, CASE WHEN a.kind = 'report' THEN NULL ELSE a.user_id END AS user_id, u.handle
       FROM activity a LEFT JOIN users u ON u.id = a.user_id
       ORDER BY a.id DESC LIMIT ?`,
    )
    .all(limit) as unknown as ActivityRow[];
  return rows.map(activityFromRow);
}

// One user's own history, including their (privately linked) reports.
export function getActivityForUser(userId: number, limit: number): ActivityEvent[] {
  const rows = db
    .prepare(
      `SELECT a.*, u.handle FROM activity a LEFT JOIN users u ON u.id = a.user_id
       WHERE a.user_id = ? ORDER BY a.id DESC LIMIT ?`,
    )
    .all(userId, limit) as unknown as ActivityRow[];
  return rows.map(activityFromRow);
}

export interface User {
  id: number;
  handle: string;
  fullName: string;
  studentId: string;
  createdAt: number;
  consentedAt: number;
}

interface UserRow {
  id: number;
  handle: string;
  full_name: string;
  student_id: string;
  pass_hash: string;
  consented_at: number;
  created_at: number;
}

function userFromRow(row: UserRow): User {
  return {
    id: row.id,
    handle: row.handle,
    fullName: row.full_name,
    studentId: row.student_id,
    createdAt: row.created_at,
    consentedAt: row.consented_at,
  };
}

// Returns null if the handle is taken (case-insensitively).
export function insertUser(
  handle: string,
  fullName: string,
  studentId: string,
  passHash: string,
  now: number,
): User | null {
  try {
    const result = db
      .prepare(
        "INSERT INTO users (handle, full_name, student_id, pass_hash, consented_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(handle, fullName, studentId, passHash, now, now);
    return { id: Number(result.lastInsertRowid), handle, fullName, studentId, createdAt: now, consentedAt: now };
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint failed/.test(err.message)) return null;
    throw err;
  }
}

export function getUserWithHash(handle: string): { user: User; passHash: string } | null {
  const row = db.prepare("SELECT * FROM users WHERE handle = ?").get(handle) as unknown as UserRow | undefined;
  return row ? { user: userFromRow(row), passHash: row.pass_hash } : null;
}

export function insertSession(tokenHash: string, userId: number, now: number, expiresAt: number): void {
  db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(
    tokenHash,
    userId,
    now,
    expiresAt,
  );
}

export function getSessionUser(tokenHash: string, now: number): User | null {
  const row = db
    .prepare(
      "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?",
    )
    .get(tokenHash, now) as unknown as UserRow | undefined;
  return row ? userFromRow(row) : null;
}

export function deleteSession(tokenHash: string): void {
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
}

// Erases a person: their account row (name, student ID, passphrase hash) and
// sessions go, and the display name stored on their claims is replaced. Log
// rows are untouched: they show "deleted user" because the join finds no
// account. Live claims are released first so no desk stays held by nobody.
export function deleteUser(userId: number): number[] {
  const live = db
    .prepare("SELECT id FROM claims WHERE user_id = ? AND status IN ('pending', 'active')")
    .all(userId) as { id: number }[];
  db.prepare("UPDATE claims SET status = 'released' WHERE user_id = ? AND status IN ('pending', 'active')").run(userId);
  db.prepare("UPDATE claims SET name = 'deleted user' WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM users WHERE id = ?").run(userId);
  return live.map((r) => r.id);
}

export function deleteExpiredSessions(now: number): void {
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
}
