import { expect, it } from "vitest";
import { claimDesk, freeDesk, post, url } from "./helpers.ts";

// The ghost-claim figure and the "here now" count, over HTTP. The pure rules
// are in spec/logic.test.ts (tallyGhosts); this checks the server's running,
// per-event tally applies them. Deltas only: the deployed app already has a
// day's worth of counts, and other tests run in parallel, so each assertion
// is "went up by at least N", scoped to this file's zone.
const ZONE = "2.25";
const ZONE_NAME = "Collaborative Learning Area 2.25";

interface Stats {
  here: number;
  today: { ghosts: number; reports: number; claims: number; byZone: Record<string, number> };
}
const stats = async (): Promise<Stats> => (await fetch(url("/api/stats"))).json();
const zoneGhosts = (s: Stats) => s.today.byZone[ZONE_NAME] ?? 0;

it("counts a 'looks free' report on a held desk as a ghost claim, live", async () => {
  const before = await stats();
  const deskId = await freeDesk(ZONE);
  const claim = await (await claimDesk(deskId)).json();

  // On a pending claim: a ghost.
  await post(`/api/desks/${deskId}/report`, { status: "free" });
  // Checked in, reported free again: another.
  await post(`/api/claims/${claim.id}/checkin`, { token: claim.claimToken });
  await post(`/api/desks/${deskId}/report`, { status: "free" });
  // "Looks taken" agrees with the claim: not a ghost.
  await post(`/api/desks/${deskId}/report`, { status: "taken" });

  const mid = await stats();
  expect(zoneGhosts(mid) - zoneGhosts(before)).toBe(2);
  expect(mid.today.reports - before.today.reports).toBeGreaterThanOrEqual(3);
  expect(mid.today.claims - before.today.claims).toBeGreaterThanOrEqual(1);

  // Released, then reported free: that agrees, so no new ghost.
  await post(`/api/claims/${claim.id}/release`, { token: claim.claimToken });
  await post(`/api/desks/${deskId}/report`, { status: "free" });
  expect(zoneGhosts(await stats())).toBe(zoneGhosts(mid));
});

it("counts the people with the page open, and pushes the change to them", async () => {
  const controller = new AbortController();
  const res = await fetch(url("/api/events"), { signal: controller.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();

  // Read stream messages until one carries stats with us counted.
  let buf = "";
  let seen: Stats | null = null;
  const deadline = Date.now() + 3000;
  while (!seen && Date.now() < deadline) {
    const { value } = await reader.read();
    buf += decoder.decode(value, { stream: true });
    for (const msg of buf.split("\n\n").slice(0, -1)) {
      const data = msg.split("\n").find((l) => l.startsWith("data: {"));
      if (data) seen = JSON.parse(data.slice(6)).stats;
    }
    buf = buf.slice(buf.lastIndexOf("\n\n") + 2);
  }
  expect(seen).not.toBeNull();
  expect(seen!.here).toBeGreaterThanOrEqual(1);
  expect((await stats()).here).toBeGreaterThanOrEqual(1);

  // No personal data in what every viewer receives.
  expect(JSON.stringify(seen)).not.toMatch(/u\d{7}|fullName|studentId/);
  controller.abort();
});
