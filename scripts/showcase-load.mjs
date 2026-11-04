// The showcase, simulated: a room of people with the page open (N live
// connections), then a burst of them signing up and claiming desks at once.
// Measures how long each change takes to reach every open session, and
// whether the one-claim-per-desk rule holds under contention.
//
//   pnpm load-check [APP_URL] [VIEWERS]   # default 60 viewers
//
// Fails if the slowest viewer sees a change after more than 1s, or if any
// desk ever gets two successful claims. Test accounts it makes are deleted.
const BASE = process.argv[2] ?? process.env.APP_URL ?? "http://localhost:8080";
const VIEWERS = Number(process.argv[3] ?? 60);
const CLAIMERS = Math.min(VIEWERS, 40);

const url = (p) => new URL(p, BASE);
const post = (p, body, cookie) =>
  fetch(url(p), {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body ?? {}),
  });

// --- open the room -------------------------------------------------------
// Each viewer keeps a live stream and records when it first sees each desk
// change state, so propagation is measured at the receiving end.
const viewers = [];
async function openViewer() {
  const ctrl = new AbortController();
  const res = await fetch(url("/api/events"), { signal: ctrl.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const v = { ctrl, seen: new Map(), here: 0 };
  (async () => {
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const msgs = buf.split("\n\n");
        buf = msgs.pop();
        const at = performance.now();
        for (const m of msgs) {
          const line = m.split("\n").find((l) => l.startsWith("data: {"));
          if (!line) continue;
          const payload = JSON.parse(line.slice(6));
          v.here = payload.stats?.here ?? v.here;
          for (const d of payload.desks) {
            if (d.status !== "available" && !v.seen.has(d.id)) v.seen.set(d.id, at);
          }
        }
      }
    } catch {}
  })();
  viewers.push(v);
}

const t0 = performance.now();
await Promise.all(Array.from({ length: VIEWERS }, openViewer));
console.log(`${VIEWERS} viewers connected in ${Math.round(performance.now() - t0)}ms`);
await new Promise((r) => setTimeout(r, 1500));
const hereSeen = Math.max(...viewers.map((v) => v.here));
console.log(`"here now" shown to viewers: ${hereSeen} (expected ≥ ${VIEWERS})`);

// --- the burst -----------------------------------------------------------
const desks = (await (await fetch(url("/api/desks"))).json()).filter((d) => d.status === "available");
const targets = desks.slice(0, Math.ceil(CLAIMERS / 2));
const stamp = Date.now().toString(36);
const users = await Promise.all(
  Array.from({ length: CLAIMERS }, async (_, i) => {
    const res = await post("/api/signup", {
      handle: `t-load-${stamp}-${i}`.slice(0, 24),
      fullName: "Load Test",
      studentId: "u0000000",
      passphrase: "correct horse battery",
      consent: true,
    });
    if (res.status !== 201) throw new Error(`signup ${res.status}: ${await res.text()}`);
    return { cookie: res.headers.get("set-cookie").split(";")[0] };
  }),
);
console.log(`${CLAIMERS} accounts created; ${CLAIMERS} people now claim ${targets.length} desks, two per desk, at once`);

// Two claimers per desk, all fired together.
const sent = new Map();
const results = await Promise.all(
  users.map(async (u, i) => {
    const desk = targets[i % targets.length];
    const start = performance.now();
    if (!sent.has(desk.id)) sent.set(desk.id, start);
    const res = await post(`/api/desks/${desk.id}/claim`, {}, u.cookie);
    const body = await res.json().catch(() => ({}));
    return { deskId: desk.id, status: res.status, ms: performance.now() - start, body, u };
  }),
);

await new Promise((r) => setTimeout(r, 2000));

// --- results -------------------------------------------------------------
const wins = new Map();
for (const r of results) if (r.status === 201) wins.set(r.deskId, (wins.get(r.deskId) ?? 0) + 1);
const doubleBooked = [...wins].filter(([, n]) => n > 1);
const statuses = results.reduce((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {});
const claimMs = results.map((r) => r.ms).sort((a, b) => a - b);

const lags = [];
let missing = 0;
for (const v of viewers) {
  for (const [deskId] of wins) {
    const seenAt = v.seen.get(deskId);
    if (seenAt === undefined) missing++;
    else lags.push(seenAt - sent.get(deskId));
  }
}
lags.sort((a, b) => a - b);
const pct = (a, p) => Math.round(a[Math.min(a.length - 1, Math.floor(a.length * p))]);

console.log(`claim responses: ${JSON.stringify(statuses)}; p50 ${pct(claimMs, 0.5)}ms, max ${Math.round(claimMs.at(-1))}ms`);
console.log(`desks with two successful claims: ${doubleBooked.length}`);
console.log(
  `change reached every viewer: p50 ${pct(lags, 0.5)}ms, p95 ${pct(lags, 0.95)}ms, max ${Math.round(lags.at(-1))}ms ` +
    `(${lags.length} deliveries, ${missing} missed)`,
);

// --- clean up ------------------------------------------------------------
for (const v of viewers) v.ctrl.abort();
await Promise.all(
  results.map(async (r) => {
    if (r.status === 201) await post(`/api/claims/${r.body.id}/release`, { token: r.body.claimToken });
  }),
);
await Promise.all(users.map((u) => fetch(url("/api/me"), { method: "DELETE", headers: { cookie: u.cookie } })));

const ok = doubleBooked.length === 0 && missing === 0 && lags.at(-1) <= 1000 && hereSeen >= VIEWERS;
console.log(ok ? "✓ the room holds: one claim per desk, every change everywhere within 1s" : "✗ failed");
process.exit(ok ? 0 : 1);
