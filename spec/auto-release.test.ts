import { expect, inject, it } from "vitest";
import { CHECKIN_GRACE_MS } from "../src/logic.ts";

// The one genuinely wall-clock test: an unconfirmed claim really does release
// itself, over the real HTTP API, within CHECKIN_GRACE_MS. Everything else
// about expiry timing is covered instantly in spec/logic.test.ts by injecting
// `now` instead of waiting — this test exists so at least one check proves
// the real system, not just the pure functions, behaves this way.
const baseUrl = inject("baseUrl");

it(
  "auto-releases an unconfirmed claim after the check-in grace period",
  async () => {
    const deskId = "2.23-1";

    const claimRes = await fetch(new URL(`/api/desks/${deskId}/claim`, baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "dana" }),
    });
    expect(claimRes.status).toBe(201);

    const desksNow = await (await fetch(new URL("/api/desks", baseUrl))).json();
    expect(desksNow.find((d: { id: string }) => d.id === deskId).status).toBe("pending");

    await new Promise((resolve) => setTimeout(resolve, CHECKIN_GRACE_MS + 2000));

    const desksAfter = await (await fetch(new URL("/api/desks", baseUrl))).json();
    const desk = desksAfter.find((d: { id: string }) => d.id === deskId);
    expect(desk.status).toBe("available");
    expect(desk.claim).toBeNull();
  },
  CHECKIN_GRACE_MS + 10_000,
);
