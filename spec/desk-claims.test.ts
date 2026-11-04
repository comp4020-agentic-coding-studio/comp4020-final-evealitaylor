import { request } from "node:http";
import { expect, inject, it } from "vitest";

// HTTP-level checks against the running app (spec/global-setup.ts finds it).
// Exercises the "no two live claims on one desk" invariant, including under
// concurrent requests, and that only the claimer can release a claim.
const baseUrl = inject("baseUrl");

it("lists the seeded desks", async () => {
  const res = await fetch(new URL("/api/desks", baseUrl));
  expect(res.status).toBe(200);
  const desks = await res.json();
  expect(Array.isArray(desks)).toBe(true);
  expect(desks.length).toBeGreaterThan(0);
  expect(desks[0]).toMatchObject({
    id: expect.any(String),
    zone: expect.any(String),
    label: expect.any(String),
    status: expect.any(String),
  });
});

it("lets one claim through and refuses an overlapping one", async () => {
  const deskId = "2.22-1";

  const first = await fetch(new URL(`/api/desks/${deskId}/claim`, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "alice" }),
  });
  expect(first.status).toBe(201);
  const claim = await first.json();
  expect(claim.deskId).toBe(deskId);

  const second = await fetch(new URL(`/api/desks/${deskId}/claim`, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "bob" }),
  });
  expect(second.status).toBe(409);

  const checkin = await fetch(new URL(`/api/claims/${claim.id}/checkin`, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: claim.claimToken }),
  });
  expect(checkin.status).toBe(200);

  const third = await fetch(new URL(`/api/desks/${deskId}/claim`, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "carol" }),
  });
  expect(third.status).toBe(409);

  const desks = await (await fetch(new URL("/api/desks", baseUrl))).json();
  const desk = desks.find((d: { id: string }) => d.id === deskId);
  expect(desk.status).toBe("occupied");
  expect(desk.claim.name).toBe("alice");
});

it("serves the QR check-in link as a page, without checking in on a bare GET", async () => {
  const deskId = "2.25-1";

  const res = await fetch(new URL(`/api/desks/${deskId}/claim`, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "dana" }),
  });
  expect(res.status).toBe(201);
  const claim = await res.json();

  // Scanning the QR is a GET from a phone browser, so the link must answer one.
  const page = await fetch(claim.checkinUrl);
  expect(page.status).toBe(200);
  expect(page.headers.get("content-type")).toContain("text/html");

  // A link previewer fetching the URL must not confirm the claim on its own.
  const desks = await (await fetch(new URL("/api/desks", baseUrl))).json();
  const desk = desks.find((d: { id: string }) => d.id === deskId);
  expect(desk.status).toBe("pending");
});

it("records a crowdsourced report without overwriting claim status", async () => {
  const deskId = "2.24-1";

  const report = await fetch(new URL(`/api/desks/${deskId}/report`, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "taken" }),
  });
  expect(report.status).toBe(201);

  const desks = await (await fetch(new URL("/api/desks", baseUrl))).json();
  const desk = desks.find((d: { id: string }) => d.id === deskId);
  // Nobody claimed it, so claim-status stays available even though someone
  // reported it taken — the mismatch is the signal, not something to hide.
  expect(desk.status).toBe("available");
  expect(desk.report.status).toBe("taken");
});

const claimDesk = (deskId: string, name: string) =>
  fetch(new URL(`/api/desks/${deskId}/claim`, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });

const release = (claimId: number, token?: string) =>
  fetch(new URL(`/api/claims/${claimId}/release`, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(token === undefined ? {} : { token }),
  });

it("lets exactly one of two overlapping claims on a free desk through", async () => {
  const deskId = "2.28-1";

  // The showcase case: two people tap the same desk at once, over a network
  // where a request's body can arrive after its headers. Open both requests,
  // send headers only, then both bodies, so each is in flight while the other
  // is being handled. A server that checks "is it free?" before awaiting the
  // body lets both through.
  const open = (name: string) => {
    const body = JSON.stringify({ name });
    const req = request(new URL(`/api/desks/${deskId}/claim`, baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    });
    const status = new Promise<number>((resolve, reject) => {
      req.on("response", (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
    });
    req.flushHeaders();
    return { send: () => req.end(body), status };
  };

  const a = open("racer-a");
  const b = open("racer-b");
  await new Promise((resolve) => setTimeout(resolve, 200));
  a.send();
  b.send();
  const statuses = (await Promise.all([a.status, b.status])).sort();
  expect(statuses).toEqual([201, 409]);
});

it("only lets the claimer check in to their own claim", async () => {
  const deskId = "2.27-2";
  const claim = await (await claimDesk(deskId, "jo")).json();

  const checkin = (token?: string) =>
    fetch(new URL(`/api/claims/${claim.id}/checkin`, baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(token === undefined ? {} : { token }),
    });

  expect((await checkin()).status).toBe(403);
  expect((await checkin("not-the-token")).status).toBe(403);
  let desks = await (await fetch(new URL("/api/desks", baseUrl))).json();
  expect(desks.find((d: { id: string }) => d.id === deskId).status).toBe("pending");

  expect((await checkin(claim.claimToken)).status).toBe(200);
  desks = await (await fetch(new URL("/api/desks", baseUrl))).json();
  expect(desks.find((d: { id: string }) => d.id === deskId).status).toBe("occupied");
});

it("only lets the claimer release their own claim", async () => {
  const deskId = "2.27-1";

  const res = await claimDesk(deskId, "erin");
  expect(res.status).toBe(201);
  const claim = await res.json();
  expect(typeof claim.claimToken).toBe("string");

  // The token is a secret for the claimer: it must not leak to other sessions.
  const listing = await (await fetch(new URL("/api/desks", baseUrl))).text();
  expect(listing).not.toContain(claim.claimToken);

  expect((await release(claim.id)).status).toBe(403);
  expect((await release(claim.id, "not-the-token")).status).toBe(403);

  let desks = await (await fetch(new URL("/api/desks", baseUrl))).json();
  expect(desks.find((d: { id: string }) => d.id === deskId).status).toBe("pending");

  expect((await release(claim.id, claim.claimToken)).status).toBe(200);
  desks = await (await fetch(new URL("/api/desks", baseUrl))).json();
  expect(desks.find((d: { id: string }) => d.id === deskId).status).toBe("available");

  // Releasing an already-released claim is refused, not silently accepted.
  expect((await release(claim.id, claim.claimToken)).status).toBe(409);
});
