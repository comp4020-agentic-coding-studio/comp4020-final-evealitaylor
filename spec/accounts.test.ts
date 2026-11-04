import { expect, it } from "vitest";
import { claimDesk, freeDesk, getDesk, post, signUp, url } from "./helpers.ts";

// Accounts over HTTP. The promise: other users see only a handle; full name
// and student ID are held for record keeping and returned only to their
// owner; claiming needs an account, reporting never does; deleting an
// account erases the person without rewriting the log.
const ZONE = "2.24";

const me = (cookie: string) => fetch(url("/api/me"), { headers: { cookie } });
const publicText = async () =>
  (await (await fetch(url("/api/desks"))).text()) + (await (await fetch(url("/api/activity?limit=200"))).text());

it("refuses to claim without signing in, and still lets anyone report", async () => {
  const deskId = await freeDesk(ZONE);
  expect((await post(`/api/desks/${deskId}/claim`, { name: "anon" })).status).toBe(401);
  expect((await getDesk(deskId)).status).toBe("available");
  expect((await post(`/api/desks/${deskId}/report`, { status: "free" })).status).toBe(201);
});

it("shows others only the handle; name and student ID only to the owner", async () => {
  const kim = await signUp("kim");
  const deskId = await freeDesk(ZONE);
  const claim = await (await claimDesk(deskId, kim)).json();
  expect(claim.name).toBe(kim.handle);

  // Everything public: the desk listing (also what the live stream sends)
  // and the activity log.
  const pub = await publicText();
  expect(pub).toContain(kim.handle);
  expect(pub).not.toContain(kim.fullName);
  expect(pub).not.toContain(kim.studentId);

  const own = await (await me(kim.cookie)).json();
  expect(own.user).toMatchObject({ handle: kim.handle, fullName: kim.fullName, studentId: kim.studentId });
  expect(own.user).not.toHaveProperty("passHash");
  expect(own.liveClaimIds).toContain(claim.id);

  // Someone else signed in gets their own record, not kim's.
  const other = await signUp("other");
  const theirs = await (await me(other.cookie)).json();
  expect(theirs.user.handle).toBe(other.handle);
  expect(JSON.stringify(theirs)).not.toContain(kim.fullName);
  expect(await (await fetch(url("/api/me"))).json()).toMatchObject({ user: null });
});

it("lets the owner's session check in and release, and nobody else's", async () => {
  const owner = await signUp("owner");
  const stranger = await signUp("stranger");
  const deskId = await freeDesk(ZONE);
  const claim = await (await claimDesk(deskId, owner)).json();

  expect((await post(`/api/claims/${claim.id}/checkin`, {}, stranger.cookie)).status).toBe(403);
  expect((await post(`/api/claims/${claim.id}/checkin`, {}, owner.cookie)).status).toBe(200);
  expect((await post(`/api/claims/${claim.id}/release`, {}, stranger.cookie)).status).toBe(403);
  expect((await post(`/api/claims/${claim.id}/release`, {}, owner.cookie)).status).toBe(200);
  expect((await getDesk(deskId)).status).toBe("available");
});

it("keeps reports anonymous in public even when signed in, but in the reporter's own history", async () => {
  const lee = await signUp("lee");
  const deskId = await freeDesk(ZONE);
  const before = Date.now();
  expect((await post(`/api/desks/${deskId}/report`, { status: "taken" }, lee.cookie)).status).toBe(201);

  const log = await (await fetch(url("/api/activity"))).json();
  const report = log.find((e: { kind: string; deskId: string; at: number }) => e.kind === "report" && e.deskId === deskId && e.at >= before);
  expect(report.actor).toBe("Anonymous");
  expect(JSON.stringify(log)).not.toContain(lee.handle);

  const own = await (await me(lee.cookie)).json();
  expect(own.history.some((e: { kind: string; deskId: string }) => e.kind === "report" && e.deskId === deskId)).toBe(true);
});

it("rejects duplicate handles case-insensitively, and wrong passphrases with one message", async () => {
  const pat = await signUp("pat");
  const dup = await post("/api/signup", {
    handle: pat.handle.toUpperCase(),
    fullName: "Someone Else",
    studentId: "u1111111",
    passphrase: "another long one",
    consent: true,
  });
  expect(dup.status).toBe(409);

  const wrongPass = await post("/api/login", { handle: pat.handle, passphrase: "not the passphrase" });
  const noUser = await post("/api/login", { handle: "t-nobody-here", passphrase: "not the passphrase" });
  expect(wrongPass.status).toBe(401);
  expect(noUser.status).toBe(401);
  expect((await wrongPass.json()).error).toBe((await noUser.json()).error);

  const ok = await post("/api/login", { handle: pat.handle, passphrase: "correct horse battery" });
  expect(ok.status).toBe(200);
  expect(ok.headers.get("set-cookie")).toContain("HttpOnly");
});

it("deleting an account erases the person, frees their desk, and leaves log rows as 'deleted user'", async () => {
  const quinn = await signUp("quinn");
  const deskId = await freeDesk(ZONE);
  const claim = await (await claimDesk(deskId, quinn)).json();
  expect((await post(`/api/claims/${claim.id}/checkin`, {}, quinn.cookie)).status).toBe(200);

  const logBefore = await (await fetch(url("/api/activity?limit=200"))).json();
  const ids = logBefore.filter((e: { claimId: number }) => e.claimId === claim.id).map((e: { id: number }) => e.id);
  expect(ids.length).toBe(2);

  const del = await fetch(url("/api/me"), { method: "DELETE", headers: { cookie: quinn.cookie } });
  expect(del.status).toBe(200);

  // Gone: the session no longer works, the handle no longer signs in.
  expect((await (await me(quinn.cookie)).json()).user).toBeNull();
  expect((await post("/api/login", { handle: quinn.handle, passphrase: "correct horse battery" })).status).toBe(401);

  // The desk they held is free, not held by nobody.
  expect((await getDesk(deskId)).status).toBe("available");

  // The log keeps its rows (same ids, same order), now shown as "deleted user".
  const pub = await publicText();
  expect(pub).not.toContain(quinn.handle);
  const logAfter = await (await fetch(url("/api/activity"))).json();
  const same = logAfter.filter((e: { id: number }) => ids.includes(e.id));
  expect(same.map((e: { id: number }) => e.id).sort()).toEqual([...ids].sort());
  expect(same.every((e: { actor: string }) => e.actor === "deleted user")).toBe(true);
});

it("refuses state changes posted from another site", async () => {
  const res = await fetch(url("/api/logout"), { method: "POST", headers: { origin: "https://evil.example" } });
  expect(res.status).toBe(403);
});
