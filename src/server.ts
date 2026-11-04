import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { toDataURL } from "qrcode";
import {
  getDesks,
  getLiveClaims,
  getClaim,
  getReportsSince,
  getActivity,
  insertActivity,
  getClaimToken,
  insertClaimIfFree,
  markCheckedIn,
  markReleased,
  markExpired,
  insertReport,
} from "./db.ts";
import {
  activeClaimForDesk,
  computeDeskStatus,
  isClaimExpired,
  latestReportForDesk,
  CHECKIN_GRACE_MS,
  CLAIM_HOLD_MS,
  REPORT_STALE_MS,
} from "./logic.ts";
import type { ActivityEvent } from "./logic.ts";
import { renderReadmeHtml } from "./readme.ts";

const PORT = Number(process.env.PORT ?? 8080);
const PUBLIC_DIR = resolve(fileURLToPath(new URL("../public/", import.meta.url)));

const sseClients = new Set<ServerResponse>();
// Desks are seeded once and never change at runtime.
const DESKS = getDesks();
const DESK_IDS = new Set(DESKS.map((d) => d.id));
// How much history the page shows; the table itself keeps everything.
const ACTIVITY_LIMIT = 50;

function snapshot() {
  const now = Date.now();
  const claims = getLiveClaims();
  const reports = getReportsSince(now - REPORT_STALE_MS);
  return DESKS.map((desk) => {
    const claim = activeClaimForDesk(claims, desk.id, now);
    const report = latestReportForDesk(reports, desk.id, now);
    return {
      ...desk,
      status: computeDeskStatus(claims, desk.id, now),
      claim: claim
        ? {
            id: claim.id,
            name: claim.name,
            checkedIn: claim.status === "active",
            expiresAt: claim.expiresAt,
          }
        : null,
      report: report ? { status: report.status, createdAt: report.createdAt } : null,
    };
  });
}

function livePayload(): string {
  return `data: ${JSON.stringify({ desks: snapshot(), activity: getActivity(ACTIVITY_LIMIT) })}\n\n`;
}

function broadcast(): void {
  if (sseClients.size === 0) return;
  const payload = livePayload();
  for (const client of sseClients) client.write(payload);
}

// Every state change is recorded in the activity table (what the page and
// `/api/activity` show) and written as one JSON line to stdout, so
// `fly logs` narrates who did what as it happens.
function record(event: Omit<ActivityEvent, "id">): void {
  const saved = insertActivity(event);
  console.log(JSON.stringify({ ...saved, at: new Date(saved.at).toISOString() }));
}

// A ping every 15s keeps idle SSE connections from being dropped by Fly's
// proxy between real updates, and lets the page notice a dead connection
// (it treats 35s of silence as offline) since a dropped network often fires
// no error on an open EventSource.
setInterval(() => {
  for (const client of sseClients) client.write("event: ping\ndata: \n\n");
}, 15_000);

// Sweeps claims past their deadline at least once a second (unconfirmed ones
// past the check-in window, checked-in ones past the 2h hold), so
// auto-release is pushed to open sessions and logged rather than only
// discovered the next time someone happens to fetch desk state.
setInterval(() => {
  const now = Date.now();
  const expired = getLiveClaims().filter((c) => isClaimExpired(c, now));
  if (expired.length === 0) return;
  for (const claim of expired) {
    markExpired(claim.id);
    record({
      at: now,
      kind: "expire",
      deskId: claim.deskId,
      claimId: claim.id,
      actor: claim.name,
      detail: claim.status === "pending" ? "unconfirmed" : "hold-ended",
    });
  }
  broadcast();
}, 1000);

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function tokenMatches(expected: string | null, given: unknown): boolean {
  if (!expected || typeof given !== "string") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

async function serveStatic(res: ServerResponse, relativePath: string): Promise<void> {
  const target = resolve(join(PUBLIC_DIR, relativePath));
  if (!target.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const data = await readFile(target);
    res.writeHead(200, { "content-type": MIME[extname(target)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const { pathname } = url;
  const method = req.method ?? "GET";

  if (method === "GET" && pathname === "/") {
    return serveStatic(res, "index.html");
  }

  if (method === "GET" && /^\/checkin\/\d+$/.test(pathname)) {
    return serveStatic(res, "checkin.html");
  }

  if (method === "GET" && pathname.startsWith("/public/")) {
    return serveStatic(res, pathname.slice("/public/".length));
  }

  if (method === "GET" && pathname === "/readme/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderReadmeHtml());
    return;
  }

  if (method === "GET" && pathname === "/api/desks") {
    return sendJson(res, 200, snapshot());
  }

  if (method === "GET" && pathname === "/api/activity") {
    return sendJson(res, 200, getActivity(ACTIVITY_LIMIT));
  }

  if (method === "GET" && pathname === "/api/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(livePayload());
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  const claimMatch = /^\/api\/desks\/([^/]+)\/claim$/.exec(pathname);
  if (method === "POST" && claimMatch) {
    const deskId = decodeURIComponent(claimMatch[1]!);
    if (!DESK_IDS.has(deskId)) return sendJson(res, 404, { error: "no such desk" });
    // Read the body before checking the desk is free: an await between the
    // check and the insert would let two concurrent claims both pass it.
    const body = await readJsonBody(req);
    const rawName = typeof body.name === "string" ? body.name.trim() : "";
    const name = rawName ? rawName.slice(0, 40) : "Anonymous";
    const now = Date.now();
    const token = randomUUID();
    const claim = insertClaimIfFree(deskId, name, token, now, now + CHECKIN_GRACE_MS);
    if (!claim) return sendJson(res, 409, { error: "desk is already claimed" });
    record({ at: now, kind: "claim", deskId, claimId: claim.id, actor: name, detail: null });
    const checkinUrl = `${url.origin}/checkin/${claim.id}#${token}`;
    const qr = await toDataURL(checkinUrl);
    broadcast();
    return sendJson(res, 201, {
      id: claim.id,
      deskId,
      name,
      expiresAt: claim.expiresAt,
      // Only ever sent to the claimer; never in snapshots or broadcasts.
      // Required to check in or release.
      claimToken: token,
      checkinUrl,
      qr,
    });
  }

  const checkinMatch = /^\/api\/claims\/(\d+)\/checkin$/.exec(pathname);
  if (method === "POST" && checkinMatch) {
    const claimId = Number(checkinMatch[1]);
    const claim = getClaim(claimId);
    if (!claim) return sendJson(res, 404, { error: "no such claim" });
    const body = await readJsonBody(req);
    if (!tokenMatches(getClaimToken(claimId), body.token)) {
      return sendJson(res, 403, { error: "only the person who claimed this desk can check in" });
    }
    const now = Date.now();
    if (claim.status !== "pending" || isClaimExpired(claim, now)) {
      return sendJson(res, 409, { error: "claim is no longer pending" });
    }
    markCheckedIn(claimId, now, now + CLAIM_HOLD_MS);
    record({ at: now, kind: "checkin", deskId: claim.deskId, claimId, actor: claim.name, detail: null });
    broadcast();
    return sendJson(res, 200, { ok: true });
  }

  const releaseMatch = /^\/api\/claims\/(\d+)\/release$/.exec(pathname);
  if (method === "POST" && releaseMatch) {
    const claimId = Number(releaseMatch[1]);
    const claim = getClaim(claimId);
    if (!claim) return sendJson(res, 404, { error: "no such claim" });
    const body = await readJsonBody(req);
    if (!tokenMatches(getClaimToken(claimId), body.token)) {
      return sendJson(res, 403, { error: "only the person who claimed this desk can release it" });
    }
    if (claim.status !== "pending" && claim.status !== "active") {
      return sendJson(res, 409, { error: "claim is no longer live" });
    }
    markReleased(claimId);
    record({ at: Date.now(), kind: "release", deskId: claim.deskId, claimId, actor: claim.name, detail: null });
    broadcast();
    return sendJson(res, 200, { ok: true });
  }

  const reportMatch = /^\/api\/desks\/([^/]+)\/report$/.exec(pathname);
  if (method === "POST" && reportMatch) {
    const deskId = decodeURIComponent(reportMatch[1]!);
    if (!DESK_IDS.has(deskId)) return sendJson(res, 404, { error: "no such desk" });
    const body = await readJsonBody(req);
    const status = body.status === "free" || body.status === "taken" ? body.status : null;
    if (!status) return sendJson(res, 400, { error: "status must be 'free' or 'taken'" });
    const now = Date.now();
    insertReport(deskId, status, now);
    // Reports are anonymous by default; a name is optional, never required.
    const rawName = typeof body.name === "string" ? body.name.trim() : "";
    const actor = rawName ? rawName.slice(0, 40) : "Anonymous";
    record({ at: now, kind: "report", deskId, claimId: null, actor, detail: status });
    broadcast();
    return sendJson(res, 201, { ok: true });
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`listening on 0.0.0.0:${PORT}`);
});
