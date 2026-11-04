import { expect, inject, it } from "vitest";

// The activity log is what persists after every claim has expired: who did
// what to which desk, and when. Checked over HTTP against the running app.
const baseUrl = inject("baseUrl");

const post = (path: string, body: unknown = {}) =>
  fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

interface Event {
  id: number;
  at: number;
  kind: string;
  deskId: string;
  claimId: number | null;
  actor: string;
  detail: string | null;
}

const activity = async (): Promise<Event[]> =>
  (await fetch(new URL("/api/activity", baseUrl))).json();

it("records who claimed, checked in, released and reported a desk, with timestamps", async () => {
  const deskId = "quiet-study-1";
  const before = Date.now();

  const claim = await (await post(`/api/desks/${deskId}/claim`, { name: "frankie" })).json();
  expect((await post(`/api/claims/${claim.id}/checkin`, { token: claim.claimToken })).status).toBe(200);
  expect((await post(`/api/desks/${deskId}/report`, { status: "free" })).status).toBe(201);
  expect((await post(`/api/claims/${claim.id}/release`, { token: claim.claimToken })).status).toBe(200);

  const forDesk = (await activity()).filter((e) => e.deskId === deskId).reverse();
  expect(forDesk.map((e) => e.kind)).toEqual(["claim", "checkin", "report", "release"]);
  expect(forDesk.filter((e) => e.kind !== "report").every((e) => e.actor === "frankie")).toBe(true);
  expect(forDesk.find((e) => e.kind === "report")).toMatchObject({ actor: "Anonymous", detail: "free" });
  for (const e of forDesk) {
    expect(e.at).toBeGreaterThanOrEqual(before);
    expect(e.at).toBeLessThanOrEqual(Date.now());
  }

  // The log outlives the claim: the desk is free again, its history isn't gone.
  const desks = await (await fetch(new URL("/api/desks", baseUrl))).json();
  expect(desks.find((d: { id: string }) => d.id === deskId).status).toBe("available");
});

it("logs refused actions as nothing: a 409 or 403 leaves no event", async () => {
  const deskId = "quiet-study-2";
  const claim = await (await post(`/api/desks/${deskId}/claim`, { name: "gale" })).json();
  expect((await post(`/api/desks/${deskId}/claim`, { name: "hal" })).status).toBe(409);
  expect((await post(`/api/claims/${claim.id}/release`, { token: "wrong" })).status).toBe(403);

  const forDesk = (await activity()).filter((e) => e.deskId === deskId);
  expect(forDesk.map((e) => e.kind)).toEqual(["claim"]);
  expect(forDesk[0]!.actor).toBe("gale");
});

it("never exposes claim tokens in the log", async () => {
  const claim = await (await post("/api/desks/quiet-study-3/claim", { name: "ira" })).json();
  const raw = await (await fetch(new URL("/api/activity", baseUrl))).text();
  expect(raw).not.toContain(claim.claimToken);
});
