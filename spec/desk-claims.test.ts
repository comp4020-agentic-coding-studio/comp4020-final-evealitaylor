import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { expect, it } from "vitest";
import { claimDesk, freeDesk, getDesk, getDesks, post, track, url } from "./helpers.ts";

// HTTP-level checks against the running app (spec/global-setup.ts finds it).
// Exercises the "no two live claims on one desk" invariant, including under
// concurrent requests, and that only the claimer can check in or release.
// Safe to re-run against the deployed app: see spec/helpers.ts.
const ZONE = "2.2";

it("lists the seeded desks", async () => {
  const desks = await getDesks();
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
  const deskId = await freeDesk(ZONE);

  const first = await claimDesk(deskId, "alice");
  expect(first.status).toBe(201);
  const claim = await first.json();
  expect(claim.deskId).toBe(deskId);

  expect((await claimDesk(deskId, "bob")).status).toBe(409);

  expect((await post(`/api/claims/${claim.id}/checkin`, { token: claim.claimToken })).status).toBe(200);

  expect((await claimDesk(deskId, "carol")).status).toBe(409);

  const desk = await getDesk(deskId);
  expect(desk.status).toBe("occupied");
  expect(desk.claim?.name).toBe("alice");
});

it("serves the QR check-in link as a page, without checking in on a bare GET", async () => {
  const deskId = await freeDesk(ZONE);

  const res = await claimDesk(deskId, "dana");
  expect(res.status).toBe(201);
  const claim = await res.json();

  // Scanning the QR is a GET from a phone browser, so the link must answer one.
  const page = await fetch(claim.checkinUrl);
  expect(page.status).toBe(200);
  expect(page.headers.get("content-type")).toContain("text/html");

  // A link previewer fetching the URL must not confirm the claim on its own.
  expect((await getDesk(deskId)).status).toBe("pending");
});

it("records a crowdsourced report without overwriting claim status", async () => {
  const deskId = await freeDesk(ZONE);

  expect((await post(`/api/desks/${deskId}/report`, { status: "taken" })).status).toBe(201);

  const desk = await getDesk(deskId);
  // Nobody claimed it, so claim-status stays available even though someone
  // reported it taken — the mismatch is the signal, not something to hide.
  expect(desk.status).toBe("available");
  expect(desk.report?.status).toBe("taken");
});

it("lets exactly one of two overlapping claims on a free desk through", async () => {
  const deskId = await freeDesk(ZONE);

  // The showcase case: two people tap the same desk at once, over a network
  // where a request's body can arrive after its headers. Open both requests,
  // send headers only, then both bodies, so each is in flight while the other
  // is being handled. A server that checks "is it free?" before awaiting the
  // body lets both through.
  const open = (name: string) => {
    const body = JSON.stringify({ name });
    // node:http can't speak https, and APP_URL may be the deployed app.
    const target = url(`/api/desks/${deskId}/claim`);
    const request = target.protocol === "https:" ? httpsRequest : httpRequest;
    const req = request(target, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    });
    const result = new Promise<{ status: number; body: string }>((resolve, reject) => {
      req.on("response", (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      });
      req.on("error", reject);
    });
    req.flushHeaders();
    return { send: () => req.end(body), result };
  };

  const a = open("racer-a");
  const b = open("racer-b");
  await new Promise((resolve) => setTimeout(resolve, 200));
  a.send();
  b.send();
  const results = await Promise.all([a.result, b.result]);
  for (const r of results) if (r.status === 201) track(JSON.parse(r.body));
  expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
});

it("only lets the claimer check in to their own claim", async () => {
  const deskId = await freeDesk(ZONE);
  const claim = await (await claimDesk(deskId, "jo")).json();
  const checkin = (body: unknown) => post(`/api/claims/${claim.id}/checkin`, body);

  expect((await checkin({})).status).toBe(403);
  expect((await checkin({ token: "not-the-token" })).status).toBe(403);
  expect((await getDesk(deskId)).status).toBe("pending");

  expect((await checkin({ token: claim.claimToken })).status).toBe(200);
  expect((await getDesk(deskId)).status).toBe("occupied");
});

it("only lets the claimer release their own claim", async () => {
  const deskId = await freeDesk(ZONE);
  const release = (body: unknown) => post(`/api/claims/${claim.id}/release`, body);

  const res = await claimDesk(deskId, "erin");
  expect(res.status).toBe(201);
  const claim = await res.json();
  expect(typeof claim.claimToken).toBe("string");

  // The token is a secret for the claimer: it must not leak to other sessions.
  const listing = await (await fetch(url("/api/desks"))).text();
  expect(listing).not.toContain(claim.claimToken);

  expect((await release({})).status).toBe(403);
  expect((await release({ token: "not-the-token" })).status).toBe(403);
  expect((await getDesk(deskId)).status).toBe("pending");

  expect((await release({ token: claim.claimToken })).status).toBe(200);
  expect((await getDesk(deskId)).status).toBe("available");

  // Releasing an already-released claim is refused, not silently accepted.
  expect((await release({ token: claim.claimToken })).status).toBe(409);
});
