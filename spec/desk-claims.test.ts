import { expect, inject, it } from "vitest";

// HTTP-level checks against the running app (spec/global-setup.ts finds it).
// Exercises the "no two overlapping confirmed claims on one desk" invariant.
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
