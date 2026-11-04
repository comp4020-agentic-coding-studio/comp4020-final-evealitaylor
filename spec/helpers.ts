import { afterAll, afterEach, inject } from "vitest";

// The spec runs against a fresh /data in CI but also against the deployed
// app, whose database persists between runs and holds real people's claims.
// So tests never assume a desk is free or that the activity log is empty:
// they pick a desk that's free right now, scope log assertions to their own
// claim ids, and release every claim they made, so a re-run doesn't find
// desks still held from the last one (checked-in holds last 2h).
const baseUrl = inject("baseUrl");

export const url = (path: string): URL => new URL(path, baseUrl);

export const post = (path: string, body: unknown = {}, cookie?: string): Promise<Response> =>
  fetch(url(path), {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

// Claiming needs an account. Test accounts use a recognisable "t-" handle
// prefix and an obviously fake student ID; tests delete the accounts they
// make (see `signUp`), so none linger in the deployed app's users table.
let seq = 0;
const madeUsers: string[] = [];

export interface TestUser {
  handle: string;
  cookie: string;
  fullName: string;
  studentId: string;
}

export async function signUp(label = "user"): Promise<TestUser> {
  const handle = `t-${label}-${Date.now().toString(36)}${(seq++).toString(36)}`.slice(0, 24);
  const fullName = `Test ${label}`;
  const studentId = "u0000000";
  const res = await post("/api/signup", { handle, fullName, studentId, passphrase: "correct horse battery", consent: true });
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${await res.text()}`);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  madeUsers.push(cookie);
  return { handle, cookie, fullName, studentId };
}

// The default account claims are made as, created on first use.
let defaultUser: Promise<TestUser> | null = null;
export const testUser = (): Promise<TestUser> => (defaultUser ??= signUp("spec"));

export interface DeskView {
  id: string;
  status: string;
  claim: { id: number; name: string } | null;
  report: { status: string } | null;
}

export const getDesks = async (): Promise<DeskView[]> => (await fetch(url("/api/desks"))).json();

export const getDesk = async (id: string): Promise<DeskView> => {
  const desk = (await getDesks()).find((d) => d.id === id);
  if (!desk) throw new Error(`no desk ${id}`);
  return desk;
};

// Desks handed out to tests in this file, so two tests never share one.
const taken = new Set<string>();

// A desk with no live claim right now, not already handed to another test.
// vitest runs test files in parallel and each has its own `taken`, so each
// file passes its own zone prefix (e.g. "2.2") to keep files from colliding.
export async function freeDesk(zonePrefix = ""): Promise<string> {
  const desk = (await getDesks()).find(
    (d) => d.id.startsWith(zonePrefix) && d.status === "available" && !taken.has(d.id),
  );
  if (!desk) throw new Error(`no free desk${zonePrefix ? ` in ${zonePrefix}*` : ""} to test with`);
  taken.add(desk.id);
  return desk.id;
}

const made: { id: number; token: string }[] = [];

// Remember a claim this test made so it's released afterwards.
export function track(claim: { id: number; claimToken: string }): void {
  made.push({ id: claim.id, token: claim.claimToken });
}

// `as` picks the account (default: one shared test account per file).
export async function claimDesk(deskId: string, as?: TestUser): Promise<Response> {
  const user = as ?? (await testUser());
  const res = await post(`/api/desks/${deskId}/claim`, {}, user.cookie);
  if (res.status === 201) track(await res.clone().json());
  return res;
}

afterEach(async () => {
  // Releasing an already-released or expired claim is a harmless 409.
  await Promise.all(made.splice(0).map((c) => post(`/api/claims/${c.id}/release`, { token: c.token })));
});

afterAll(async () => {
  await Promise.all(
    madeUsers.splice(0).map((cookie) => fetch(url("/api/me"), { method: "DELETE", headers: { cookie } })),
  );
});
