import { afterEach, inject } from "vitest";

// The spec runs against a fresh /data in CI but also against the deployed
// app, whose database persists between runs and holds real people's claims.
// So tests never assume a desk is free or that the activity log is empty:
// they pick a desk that's free right now, scope log assertions to their own
// claim ids, and release every claim they made, so a re-run doesn't find
// desks still held from the last one (checked-in holds last 2h).
const baseUrl = inject("baseUrl");

export const url = (path: string): URL => new URL(path, baseUrl);

export const post = (path: string, body: unknown = {}): Promise<Response> =>
  fetch(url(path), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

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

export async function claimDesk(deskId: string, name: string): Promise<Response> {
  const res = await post(`/api/desks/${deskId}/claim`, { name });
  if (res.status === 201) track(await res.clone().json());
  return res;
}

afterEach(async () => {
  // Releasing an already-released or expired claim is a harmless 409.
  await Promise.all(made.splice(0).map((c) => post(`/api/claims/${c.id}/release`, { token: c.token })));
});
