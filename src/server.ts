import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { toDataURL } from "qrcode";
import {
  getDesks,
  getClaims,
  getClaim,
  getReports,
  insertClaim,
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
} from "./logic.ts";
import { renderReadmeHtml } from "./readme.ts";

const PORT = Number(process.env.PORT ?? 8080);
const PUBLIC_DIR = resolve(fileURLToPath(new URL("../public/", import.meta.url)));

const sseClients = new Set<ServerResponse>();

function snapshot() {
  const now = Date.now();
  const claims = getClaims();
  const reports = getReports();
  return getDesks().map((desk) => {
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

function broadcast(): void {
  if (sseClients.size === 0) return;
  const payload = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const client of sseClients) client.write(payload);
}

// Sweeps unconfirmed claims past their check-in deadline at least once a
// second, so auto-release is pushed to open sessions rather than only
// discovered the next time someone happens to fetch desk state.
setInterval(() => {
  const now = Date.now();
  const expired = getClaims().filter((c) => c.status === "pending" && isClaimExpired(c, now));
  if (expired.length === 0) return;
  for (const claim of expired) markExpired(claim.id);
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

  if (method === "GET" && pathname === "/api/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  const claimMatch = /^\/api\/desks\/([^/]+)\/claim$/.exec(pathname);
  if (method === "POST" && claimMatch) {
    const deskId = decodeURIComponent(claimMatch[1]!);
    const desk = getDesks().find((d) => d.id === deskId);
    if (!desk) return sendJson(res, 404, { error: "no such desk" });
    const now = Date.now();
    if (activeClaimForDesk(getClaims(), deskId, now)) {
      return sendJson(res, 409, { error: "desk is already claimed" });
    }
    const body = await readJsonBody(req);
    const rawName = typeof body.name === "string" ? body.name.trim() : "";
    const name = rawName ? rawName.slice(0, 40) : "Anonymous";
    const claim = insertClaim(deskId, name, now, now + CHECKIN_GRACE_MS);
    const checkinUrl = `${url.origin}/api/claims/${claim.id}/checkin`;
    const qr = await toDataURL(checkinUrl);
    broadcast();
    return sendJson(res, 201, {
      id: claim.id,
      deskId,
      name,
      expiresAt: claim.expiresAt,
      checkinUrl,
      qr,
    });
  }

  const checkinMatch = /^\/api\/claims\/(\d+)\/checkin$/.exec(pathname);
  if (method === "POST" && checkinMatch) {
    const claimId = Number(checkinMatch[1]);
    const claim = getClaim(claimId);
    if (!claim) return sendJson(res, 404, { error: "no such claim" });
    const now = Date.now();
    if (claim.status !== "pending" || isClaimExpired(claim, now)) {
      return sendJson(res, 409, { error: "claim is no longer pending" });
    }
    markCheckedIn(claimId, now, now + CLAIM_HOLD_MS);
    broadcast();
    return sendJson(res, 200, { ok: true });
  }

  const releaseMatch = /^\/api\/claims\/(\d+)\/release$/.exec(pathname);
  if (method === "POST" && releaseMatch) {
    const claimId = Number(releaseMatch[1]);
    const claim = getClaim(claimId);
    if (!claim) return sendJson(res, 404, { error: "no such claim" });
    markReleased(claimId);
    broadcast();
    return sendJson(res, 200, { ok: true });
  }

  const reportMatch = /^\/api\/desks\/([^/]+)\/report$/.exec(pathname);
  if (method === "POST" && reportMatch) {
    const deskId = decodeURIComponent(reportMatch[1]!);
    const desk = getDesks().find((d) => d.id === deskId);
    if (!desk) return sendJson(res, 404, { error: "no such desk" });
    const body = await readJsonBody(req);
    const status = body.status === "free" || body.status === "taken" ? body.status : null;
    if (!status) return sendJson(res, 400, { error: "status must be 'free' or 'taken'" });
    insertReport(deskId, status, Date.now());
    broadcast();
    return sendJson(res, 201, { ok: true });
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`listening on 0.0.0.0:${PORT}`);
});
