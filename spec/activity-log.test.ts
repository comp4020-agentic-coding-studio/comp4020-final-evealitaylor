import { expect, it } from "vitest";
import { claimDesk, freeDesk, getDesk, post, signUp, testUser, url } from "./helpers.ts";

// The activity log is what persists after every claim has expired: who did
// what to which desk, and when. Checked over HTTP against the running app.
// The log is permanent, so assertions look only at this test's own claim ids
// and timestamps, never at a desk's whole history (spec/helpers.ts).

interface Event {
  id: number;
  at: number;
  kind: string;
  deskId: string;
  claimId: number | null;
  actor: string;
  detail: string | null;
}

const ZONE = "quiet-study";

const activity = async (): Promise<Event[]> => (await fetch(url("/api/activity"))).json();

it("records who claimed, checked in, released and reported a desk, with timestamps", async () => {
  const deskId = await freeDesk(ZONE);
  const before = Date.now();

  const frankie = await testUser();
  const claim = await (await claimDesk(deskId)).json();
  expect((await post(`/api/claims/${claim.id}/checkin`, { token: claim.claimToken })).status).toBe(200);
  expect((await post(`/api/desks/${deskId}/report`, { status: "free" })).status).toBe(201);
  expect((await post(`/api/claims/${claim.id}/release`, { token: claim.claimToken })).status).toBe(200);

  const log = await activity();
  const ours = log.filter((e) => e.claimId === claim.id).reverse();
  expect(ours.map((e) => e.kind)).toEqual(["claim", "checkin", "release"]);
  expect(ours.every((e) => e.actor === frankie.handle && e.deskId === deskId)).toBe(true);

  // Reports aren't tied to a claim, so find this one by desk and time.
  const report = log.find((e) => e.kind === "report" && e.deskId === deskId && e.at >= before);
  expect(report).toMatchObject({ actor: "Anonymous", detail: "free", claimId: null });

  for (const e of [...ours, report!]) {
    expect(e.at).toBeGreaterThanOrEqual(before);
    expect(e.at).toBeLessThanOrEqual(Date.now());
  }
  // Ordered as they happened: report between check-in and release.
  expect(ours[1]!.id).toBeLessThan(report!.id);
  expect(report!.id).toBeLessThan(ours[2]!.id);

  // The log outlives the claim: the desk is free again, its history isn't gone.
  expect((await getDesk(deskId)).status).toBe("available");
});

it("logs refused actions as nothing: a 409 or 403 leaves no event", async () => {
  const deskId = await freeDesk(ZONE);
  const before = Date.now();
  const claim = await (await claimDesk(deskId)).json();
  const hal = await signUp("hal");
  expect((await claimDesk(deskId, hal)).status).toBe(409);
  expect((await post(`/api/claims/${claim.id}/release`, { token: "wrong" })).status).toBe(403);
  expect((await post(`/api/claims/${claim.id}/checkin`, { token: "wrong" })).status).toBe(403);

  const log = await activity();
  expect(log.filter((e) => e.claimId === claim.id).map((e) => e.kind)).toEqual(["claim"]);
  expect(log.some((e) => e.actor === hal.handle && e.at >= before)).toBe(false);
});

it("never exposes claim tokens in the log", async () => {
  const claim = await (await claimDesk(await freeDesk(ZONE))).json();
  const raw = await (await fetch(url("/api/activity"))).text();
  expect(raw).not.toContain(claim.claimToken);
});
