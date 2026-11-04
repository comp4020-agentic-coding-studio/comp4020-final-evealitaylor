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
  insertUser,
  getUserWithHash,
  insertSession,
  getSessionUser,
  deleteSession,
  deleteUser,
  deleteExpiredSessions,
  getActivityForUser,
  getActivitySince,
} from "./db.ts";
import type { User } from "./db.ts";
import {
  validateSignup,
  hashPassphrase,
  verifyPassphrase,
  newSessionToken,
  hashSessionToken,
  sessionCookie,
  clearedSessionCookie,
  readSessionCookie,
  SESSION_MS,
} from "./accounts.ts";
import {
  activeClaimForDesk,
  computeDeskStatus,
  isClaimExpired,
  latestReportForDesk,
  CHECKIN_GRACE_MS,
  CLAIM_HOLD_MS,
  REPORT_STALE_MS,
  startOfLibraryDay,
  tallyGhosts,
} from "./logic.ts";
import type { ActivityEvent, GhostTally } from "./logic.ts";
import { renderReadmeHtml } from "./readme.ts";

const PORT = Number(process.env.PORT ?? 8080);
const PUBLIC_DIR = resolve(fileURLToPath(new URL("../public/", import.meta.url)));

const sseClients = new Set<ServerResponse>();
// Desks are seeded once and never change at runtime.
const DESKS = getDesks();
const DESK_IDS = new Set(DESKS.map((d) => d.id));
const ZONE_OF = new Map(DESKS.map((d) => [d.id, d.zone]));
const zoneOf = (deskId: string) => ZONE_OF.get(deskId) ?? "Unknown";

// Today's ghost tally, kept in memory and updated per event rather than
// recomputed from the log on every broadcast (that would scale with
// history; see "Cost stays flat" in CLAUDE.md). Seeded by one replay at
// startup and at each Canberra midnight.
let ghostDay = 0;
let ghostTally: GhostTally = { ghosts: 0, reports: 0, claims: 0, byZone: {} };
const deskHeld = new Map<string, boolean>();

function reseedGhosts(now: number): void {
  ghostDay = startOfLibraryDay(now);
  const events = getActivitySince(ghostDay);
  ghostTally = tallyGhosts(events, zoneOf, ghostDay);
  deskHeld.clear();
  for (const e of events) {
    if (e.kind === "claim") deskHeld.set(e.deskId, true);
    else if (e.kind === "release" || e.kind === "expire") deskHeld.set(e.deskId, false);
  }
}

// Mirrors tallyGhosts for one new event (spec/logic.test.ts pins the rules;
// spec/ghosts.test.ts checks this incremental path agrees over HTTP).
function countGhost(e: Omit<ActivityEvent, "id">): void {
  if (startOfLibraryDay(e.at) !== ghostDay) reseedGhosts(e.at);
  if (e.kind === "claim") {
    deskHeld.set(e.deskId, true);
    ghostTally.claims++;
  } else if (e.kind === "release" || e.kind === "expire") {
    deskHeld.set(e.deskId, false);
  } else if (e.kind === "report") {
    ghostTally.reports++;
    if (e.detail === "free" && deskHeld.get(e.deskId)) {
      ghostTally.ghosts++;
      const zone = zoneOf(e.deskId);
      ghostTally.byZone[zone] = (ghostTally.byZone[zone] ?? 0) + 1;
    }
  }
}

reseedGhosts(Date.now());

function stats() {
  if (startOfLibraryDay(Date.now()) !== ghostDay) reseedGhosts(Date.now());
  // People with the page open right now: the room, made visible to itself.
  return { here: sseClients.size, today: ghostTally };
}
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
  return `data: ${JSON.stringify({ desks: snapshot(), activity: getActivity(ACTIVITY_LIMIT), stats: stats() })}\n\n`;
}

// Coalesces bursts (a room of people connecting at once, a flurry of
// claims) into one snapshot per BROADCAST_MS, so cost is per update window,
// not per event times per client. 100ms keeps well inside the 1s budget.
const BROADCAST_MS = 100;
let broadcastQueued = false;

function broadcast(): void {
  if (broadcastQueued) return;
  broadcastQueued = true;
  setTimeout(() => {
    broadcastQueued = false;
    if (sseClients.size === 0) return;
    const payload = livePayload();
    for (const client of sseClients) client.write(payload);
  }, BROADCAST_MS);
}

// Every state change is recorded in the activity table (what the page and
// `/api/activity` show) and written as one JSON line to stdout, so
// `fly logs` narrates who did what as it happens.
// Logs carry the public handle and the internal user id, never full names,
// student IDs, passphrases or any token.
function record(event: Omit<ActivityEvent, "id">, userId: number | null = null): void {
  const saved = insertActivity(event, userId);
  countGhost(event);
  console.log(JSON.stringify({ ...saved, userId, at: new Date(saved.at).toISOString() }));
}

function currentUser(req: IncomingMessage): User | null {
  const token = readSessionCookie(req.headers.cookie);
  return token ? getSessionUser(hashSessionToken(token), Date.now()) : null;
}

// Behind Fly's proxy the app sees plain http, so trust its forwarded header
// to decide whether the cookie may be marked Secure.
function isHttps(req: IncomingMessage): boolean {
  return req.headers["x-forwarded-proto"] === "https";
}

// The claim token (from the claimer's browser or the QR link) or being
// signed in as the account that made the claim: either proves ownership.
function ownsClaim(req: IncomingMessage, claimId: number, claimUserId: number | null, token: unknown): boolean {
  if (tokenMatches(getClaimToken(claimId), token)) return true;
  const user = currentUser(req);
  return user !== null && claimUserId !== null && user.id === claimUserId;
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
    }, claim.userId);
  }
  broadcast();
}, 1000);

setInterval(() => deleteExpiredSessions(Date.now()), 60 * 60 * 1000);

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

  // Cookies authenticate now, so refuse state changes sent from another
  // site's page (SameSite=Lax already withholds the cookie; this is a second
  // layer). Requests with no Origin (curl, the spec) are allowed.
  if (method !== "GET" && req.headers.origin) {
    let sameOrigin = false;
    try {
      sameOrigin = new URL(req.headers.origin).host === req.headers.host;
    } catch {}
    if (!sameOrigin) return sendJson(res, 403, { error: "cross-site request refused" });
  }

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

  if (method === "GET" && pathname === "/api/stats") {
    return sendJson(res, 200, stats());
  }

  if (method === "GET" && pathname === "/api/activity") {
    const asked = Number(url.searchParams.get("limit"));
    const limit = Number.isInteger(asked) && asked > 0 ? Math.min(asked, 200) : ACTIVITY_LIMIT;
    return sendJson(res, 200, getActivity(limit));
  }

  if (method === "GET" && pathname === "/api/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    sseClients.add(res);
    // Everyone (including the newcomer) sees the "here now" count change.
    broadcast();
    req.on("close", () => {
      sseClients.delete(res);
      broadcast();
    });
    return;
  }

  const claimMatch = /^\/api\/desks\/([^/]+)\/claim$/.exec(pathname);
  if (method === "POST" && claimMatch) {
    const deskId = decodeURIComponent(claimMatch[1]!);
    if (!DESK_IDS.has(deskId)) return sendJson(res, 404, { error: "no such desk" });
    // Read the body before checking the desk is free: an await between the
    // check and the insert would let two concurrent claims both pass it.
    await readJsonBody(req);
    // Claiming needs an account so every claim belongs to a person. Looking
    // up the session is synchronous, so it doesn't reopen that gap.
    const user = currentUser(req);
    if (!user) return sendJson(res, 401, { error: "sign in to claim a desk" });
    const name = user.handle;
    const now = Date.now();
    const token = randomUUID();
    const claim = insertClaimIfFree(deskId, user.id, name, token, now, now + CHECKIN_GRACE_MS);
    if (!claim) return sendJson(res, 409, { error: "desk is already claimed" });
    record({ at: now, kind: "claim", deskId, claimId: claim.id, actor: name, detail: null }, user.id);
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
    if (!ownsClaim(req, claimId, claim.userId, body.token)) {
      return sendJson(res, 403, { error: "only the person who claimed this desk can check in" });
    }
    const now = Date.now();
    if (claim.status !== "pending" || isClaimExpired(claim, now)) {
      return sendJson(res, 409, { error: "claim is no longer pending" });
    }
    markCheckedIn(claimId, now, now + CLAIM_HOLD_MS);
    record({ at: now, kind: "checkin", deskId: claim.deskId, claimId, actor: claim.name, detail: null }, claim.userId);
    broadcast();
    return sendJson(res, 200, { ok: true });
  }

  const releaseMatch = /^\/api\/claims\/(\d+)\/release$/.exec(pathname);
  if (method === "POST" && releaseMatch) {
    const claimId = Number(releaseMatch[1]);
    const claim = getClaim(claimId);
    if (!claim) return sendJson(res, 404, { error: "no such claim" });
    const body = await readJsonBody(req);
    if (!ownsClaim(req, claimId, claim.userId, body.token)) {
      return sendJson(res, 403, { error: "only the person who claimed this desk can release it" });
    }
    if (claim.status !== "pending" && claim.status !== "active") {
      return sendJson(res, 409, { error: "claim is no longer live" });
    }
    markReleased(claimId);
    record({ at: Date.now(), kind: "release", deskId: claim.deskId, claimId, actor: claim.name, detail: null }, claim.userId);
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
    // Reports never need an account, and are always public as "Anonymous" so
    // people report what they see without it being tied to them. If the
    // reporter is signed in, the link is kept privately for their own history.
    const user = currentUser(req);
    insertReport(deskId, status, now, user?.id ?? null);
    record({ at: now, kind: "report", deskId, claimId: null, actor: "Anonymous", detail: status }, user?.id ?? null);
    broadcast();
    return sendJson(res, 201, { ok: true });
  }

  if (method === "POST" && pathname === "/api/signup") {
    const body = await readJsonBody(req);
    const input = validateSignup(body);
    if (!input.ok) return sendJson(res, 400, { error: input.error });
    const { handle, fullName, studentId, passphrase } = input.value;
    const now = Date.now();
    const user = insertUser(handle, fullName, studentId, hashPassphrase(passphrase), now);
    if (!user) return sendJson(res, 409, { error: "That handle is taken. Pick another." });
    console.log(JSON.stringify({ kind: "signup", userId: user.id, handle: user.handle, at: new Date(now).toISOString() }));
    return startSession(req, res, user, 201);
  }

  if (method === "POST" && pathname === "/api/login") {
    const body = await readJsonBody(req);
    const handle = typeof body.handle === "string" ? body.handle.trim() : "";
    const passphrase = typeof body.passphrase === "string" ? body.passphrase : "";
    const found = handle ? getUserWithHash(handle) : null;
    // Same message whether the handle or passphrase is wrong.
    if (!found || !verifyPassphrase(passphrase, found.passHash)) {
      return sendJson(res, 401, { error: "Handle or passphrase is wrong." });
    }
    return startSession(req, res, found.user, 200);
  }

  if (method === "POST" && pathname === "/api/logout") {
    const token = readSessionCookie(req.headers.cookie);
    if (token) deleteSession(hashSessionToken(token));
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "set-cookie": clearedSessionCookie(isHttps(req)),
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Your own record: the only place full name and student ID are returned.
  // Signed out is a normal state for this page, not an error, so it's a 200
  // with `user: null` rather than a 401 that every visit would log.
  if (method === "GET" && pathname === "/api/me") {
    const user = currentUser(req);
    if (!user) return sendJson(res, 200, { user: null, liveClaimIds: [], history: [] });
    const liveClaimIds = getLiveClaims()
      .filter((c) => c.userId === user.id)
      .map((c) => c.id);
    return sendJson(res, 200, { user, liveClaimIds, history: getActivityForUser(user.id, 200) });
  }

  if (method === "DELETE" && pathname === "/api/me") {
    const user = currentUser(req);
    if (!user) return sendJson(res, 401, { error: "not signed in" });
    const released = deleteUser(user.id);
    const now = Date.now();
    for (const claimId of released) {
      const claim = getClaim(claimId);
      if (claim) record({ at: now, kind: "release", deskId: claim.deskId, claimId, actor: "deleted user", detail: null });
    }
    console.log(JSON.stringify({ kind: "account-deleted", userId: user.id, at: new Date(now).toISOString() }));
    broadcast();
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "set-cookie": clearedSessionCookie(isHttps(req)),
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

function startSession(req: IncomingMessage, res: ServerResponse, user: User, status: number): void {
  const token = newSessionToken();
  const now = Date.now();
  insertSession(hashSessionToken(token), user.id, now, now + SESSION_MS);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "set-cookie": sessionCookie(token, isHttps(req)),
  });
  // The handle only: the page has no need for the private fields.
  res.end(JSON.stringify({ handle: user.handle }));
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`listening on 0.0.0.0:${PORT}`);
});
