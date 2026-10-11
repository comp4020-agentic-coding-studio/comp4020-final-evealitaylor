import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SEED_DESKS } from "./seed.ts";
import type { Claim, ClaimStatus, Desk, OccupancyReport, ReportStatus } from "./logic.ts";

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
  CREATE TABLE IF NOT EXISTS occupancy_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    desk_id TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
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

export function insertClaim(deskId: string, name: string, startedAt: number, expiresAt: number): Claim {
  const result = db
    .prepare(
      "INSERT INTO claims (desk_id, name, started_at, checked_in_at, expires_at, status) VALUES (?, ?, ?, NULL, ?, 'pending')",
    )
    .run(deskId, name, startedAt, expiresAt);
  return {
    id: Number(result.lastInsertRowid),
    deskId,
    name,
    startedAt,
    checkedInAt: null,
    expiresAt,
    status: "pending",
  };
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
