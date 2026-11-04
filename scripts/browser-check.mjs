// Two-profile browser pass for what `pnpm check` (HTTP only) can't see: both
// marking viewports, keyboard, resize mid-interaction, slow and dropped
// connections. See CLAUDE.md "Holds up under bad conditions".
//
//   pnpm exec playwright-core install chromium   # once
//   pnpm browser-check [APP_URL]           # app must be running; uses a desk on it
//
// Screenshots land in $SHOTS_DIR (default: a temp dir, printed at the end).
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { chromium } = await import("playwright-core").catch(() => {
  console.error("playwright-core not found: run `pnpm install`");
  process.exit(1);
});
const BASE = process.argv[2] ?? process.env.APP_URL ?? "http://localhost:8080";
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), "seat-seeker-shots");
mkdirSync(SHOTS, { recursive: true });
const out = [];
const log = (...a) => { out.push(a.join(" ")); console.log(...a); };
const browser = await chromium.launch();
const VIEWS = { desktop: { width: 1920, height: 1080 }, phone: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 } };

async function overflow(page) {
  return page.evaluate(() => {
    const w = document.documentElement.clientWidth;
    const bad = [...document.querySelectorAll("body *")].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && (r.right > w + 1 || r.left < -1) && getComputedStyle(el).position !== "fixed";
    }).slice(0, 5).map((el) => el.tagName + "." + el.className?.baseVal ?? el.className);
    return { scrollW: document.documentElement.scrollWidth, w, bad };
  });
}

// Separate contexts = separate Chrome profiles (no shared storage)
const ctx = {};
for (const [name, v] of Object.entries(VIEWS)) {
  const { width, height, ...rest } = v;
  ctx[name] = await browser.newContext({ viewport: { width, height }, ...rest });
}
const A = await ctx.desktop.newPage();
const B = await ctx.phone.newPage();
const errors = [];
for (const [n, p] of [["desktop", A], ["phone", B]]) {
  p.on("pageerror", (e) => errors.push(`${n}: ${e.message}`));
  p.on("console", (m) => m.type() === "error" && errors.push(`${n} console: ${m.text()}`));
  await p.goto(BASE);
  await p.waitForSelector("#conn.conn--live", { timeout: 8000 });
}
log("both live");

for (const [n, p] of [["desktop", A], ["phone", B]]) {
  const o = await overflow(p);
  log(`${n} overflow: scrollW=${o.scrollW} vw=${o.w}`, o.bad.length ? "BAD " + o.bad.join(",") : "ok");
  await p.screenshot({ path: `${SHOTS}/${n}-1-initial.png`, fullPage: true });
}

// Desktop claims a desk via keyboard only. Against a deployed app some desks
// may already be claimed by real people, so Tab on to the first free one.
await A.keyboard.press("Tab"); // brand
let tabs = 1;
let firstDesk = null;
let deskId = null;
while (tabs < 120 && !deskId) {
  await A.keyboard.press("Tab"); tabs++;
  const seat = await A.evaluate(() => {
    const el = document.activeElement;
    return el?.getAttribute("data-id") ? { id: el.getAttribute("data-id"), free: el.classList.contains("seat--available") } : null;
  });
  if (seat && !firstDesk) { firstDesk = seat.id; log(`keyboard reached first desk ${seat.id} after ${tabs} tabs`); }
  if (seat?.free) deskId = seat.id;
}
if (!deskId) throw new Error("no free desk reachable by keyboard");
log(`keyboard reached free desk ${deskId} after ${tabs} tabs`);
await A.keyboard.press("Enter");
await A.waitForSelector("#claim-name");
await A.focus("#claim-name");
await A.keyboard.type("Desktop Dee");
await A.keyboard.press("Tab");
await A.keyboard.press("Enter"); // Claim button
await A.waitForSelector(".pill--yellow", { timeout: 3000 });
const t0 = Date.now();
await B.waitForFunction((id) => document.querySelector(`[data-id="${id}"]`)?.classList.contains("seat--pending"), deskId, { timeout: 3000 });
log(`phone saw desktop's claim in ~${Date.now() - t0}ms`);
await B.waitForFunction(() => document.querySelector("#activity-list")?.textContent.includes("Desktop Dee"), null, { timeout: 3000 });
log("phone activity log shows the claim");
await A.screenshot({ path: `${SHOTS}/desktop-2-claimed.png` });

// Escape returns focus to desk
await A.keyboard.press("Escape");
const back = await A.evaluate(() => document.activeElement?.getAttribute("data-id"));
log(`after Escape focus is on desk: ${back === deskId ? "yes" : "NO (" + back + ")"}`);

// Phone: tap the same desk, sees claimed by Desktop Dee, no release button
await B.locator(`[data-id="${deskId}"]`).tap();
await B.waitForSelector(".sheet.open");
const phoneSees = await B.evaluate(() => ({ text: document.querySelector("#sheet-body").textContent.includes("Desktop Dee"), checkin: !!document.querySelector('[data-action="checkin"]'), qr: !!document.querySelector(".qr") }));
log(`phone sheet shows claimer: ${phoneSees.text}; shows someone else's Check in button / QR (both should be false): ${phoneSees.checkin} / ${phoneSees.qr}`);
await B.waitForTimeout(400);
const sheetBox = await B.evaluate(() => { const r = document.querySelector("#sheet").getBoundingClientRect(); return { top: r.top, bottom: r.bottom, h: innerHeight }; });
log(`phone sheet box top=${Math.round(sheetBox.top)} bottom=${Math.round(sheetBox.bottom)} viewport=${sheetBox.h}`);
await B.screenshot({ path: `${SHOTS}/phone-2-sheet.png` });

// Desktop checks in, phone sees occupied
await A.locator(`[data-id="${deskId}"]`).click();
await A.click('[data-action="checkin"]');
await B.waitForFunction((id) => document.querySelector(`[data-id="${id}"]`)?.classList.contains("seat--occupied"), deskId, { timeout: 3000 });
log("phone saw check-in");

// Resize mid-interaction: desktop with sheet open, shrink to phone and back
await A.setViewportSize({ width: 390, height: 844 });
await A.waitForTimeout(400);
let o = await overflow(A);
const sheetOpen = await A.evaluate(() => document.querySelector("#sheet").classList.contains("open") && document.querySelector("#sheet").getBoundingClientRect().top < innerHeight);
log(`resized desktop->phone with sheet open: overflow ${o.scrollW}/${o.w} ${o.bad.join(",") || "ok"}, sheet visible: ${sheetOpen}`);
await A.screenshot({ path: `${SHOTS}/resize-to-phone.png` });
await A.setViewportSize({ width: 1920, height: 1080 });
await A.waitForTimeout(400);
o = await overflow(A);
log(`resized back: overflow ${o.scrollW}/${o.w} ${o.bad.join(",") || "ok"}`);

// Slow 3G on phone: report and see buttons disable
const cdp = await ctx.phone.newCDPSession(B);
await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 2000, downloadThroughput: 50000, uploadThroughput: 50000 });
await B.click('[data-action="report-free"]');
const disabled = await B.evaluate(() => [...document.querySelectorAll('[data-action="report-free"],[data-action="report-taken"]')].every((b) => b.disabled));
log(`slow network: buttons disabled while in flight: ${disabled}`);
await B.screenshot({ path: `${SHOTS}/phone-3-slow-inflight.png` });
await B.waitForFunction(() => !document.querySelector('[data-action="report-free"]')?.disabled, null, { timeout: 15000 });
const mismatch = await A.evaluate((id) => document.querySelector(`[data-id="${id}"]`)?.classList.contains("seat--mismatch"), deskId);
log(`slow report completed; desktop shows mismatch ring: ${mismatch}`);

// Offline: indicator + error message, then recovery
await cdp.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
await B.click('[data-action="report-taken"]');
await B.waitForSelector(".msg", { timeout: 12000 });
log(`offline action shows error: "${await B.textContent(".msg")}"`);
await B.evaluate(() => window.dispatchEvent(new Event("offline")));
await B.waitForSelector("#conn.conn--offline", { timeout: 8000 }).then(() => log("offline indicator shown")).catch(() => log("offline indicator NOT shown"));
await B.screenshot({ path: `${SHOTS}/phone-4-offline.png` });
// change happens while phone offline
await A.click('[data-action="release"]');
await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
await B.waitForSelector("#conn.conn--live", { timeout: 10000 });
await B.waitForTimeout(300);
log(`stale offline error cleared after reconnect: ${!(await B.$(".msg"))}`);
const caughtUp = await B.waitForFunction((id) => document.querySelector(`[data-id="${id}"]`)?.classList.contains("seat--available"), deskId, { timeout: 5000 }).then(() => true).catch(() => false);
log(`back online: live again, caught up on release made while offline: ${caughtUp}`);

await A.screenshot({ path: `${SHOTS}/desktop-5-final.png`, fullPage: true });
await B.screenshot({ path: `${SHOTS}/phone-5-final.png`, fullPage: true });
log("errors:", errors.length ? errors.join(" | ") : "none");
await browser.close();
log(`screenshots: ${SHOTS}`);
