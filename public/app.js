const NS = "http://www.w3.org/2000/svg";
const SEAT_R = 9;
const SQUARE = 20;

// Walls, rooms and areas are traced from ANU Library's "Hancock Library floor
// plan" (Feb 2021, Level 2), in that image's pixel coordinates. Seat positions
// within each area are not on the plan, so they (and the counts) are estimates.
const WINGS = [
  { name: "West wing", label: [940, 398], fill: "wing--west",
    d: "M938 455 L1030 455 L1030 408 L1235 408 L1235 750 L1160 750 L1160 780 L938 780 Z" },
  { name: "East wing · Quiet zone", label: [1030, 836], fill: "wing--east",
    d: "M882 850 L992 850 L992 805 L1018 805 L1018 1080 L1050 1080 L1050 1065 L1120 1065 L1120 1080 L1155 1080 L1155 845 L1290 845 L1290 1105 L1268 1105 L1268 1290 L1150 1290 L1150 1230 L985 1230 L985 1290 L908 1290 L908 1130 L992 1130 L992 945 L882 945 Z" },
];

const FEATURES = [
  { rect: [1000, 470, 87, 62], cls: "void" },
  { rect: [941, 475, 44, 30], cls: "core", text: ["Comms", 963, 493] },
  { rect: [941, 510, 47, 48], cls: "core", text: ["Science Soc.", 964, 537] },
  { rect: [1160, 410, 42, 16], cls: "core", text: ["Stairs", 1181, 421] },
  { text: ["WC", 980, 446] },
  { text: ["Open collaboration", 1162, 446], cls: "core-label open" },
  { text: ["Open", 1091, 640], cls: "core-label open" },
  { text: ["collaboration", 1091, 649], cls: "core-label open" },
  { rect: [1057, 1130, 60, 67], cls: "void" },
  { rect: [1050, 1065, 70, 45], cls: "core", text: ["Stairs", 1085, 1091] },
  { rect: [976, 1062, 14, 14], cls: "core" },
  { text: ["Lift", 966, 1073], cls: "core-label end" },
  { text: ["WC", 972, 1122] },
  { text: ["WC", 1222, 1122] },
];

// Each zone's seeded desks fill its areas in order; the real plan splits the
// computer and study zones across both sides of the East Wing.
const ZONES = [
  { code: "2.22", areas: [{ title: "2.22", sub: "Collab.", count: 7, kind: "round", c: [1194, 515], label: [1123, 500],
      d: "M1118 480 L1235 465 L1235 555 L1150 560 L1118 540 Z" }] },
  { code: "2.23", areas: [{ title: "2.23", sub: "Collab.", count: 7, kind: "round", c: [1196, 597], label: [1123, 590],
      d: "M1118 575 L1150 562 L1235 557 L1235 630 L1200 640 L1118 615 Z" }] },
  { code: "2.24", areas: [{ title: "2.24", sub: "Collab.", count: 7, kind: "round", c: [1196, 690], label: [1127, 680],
      d: "M1118 660 L1150 642 L1235 632 L1235 740 L1170 750 L1120 700 Z" }] },
  { code: "2.25", areas: [{ title: "2.25", sub: "Collab.", count: 7, kind: "long", c: [1095, 745], label: [1046, 702],
      d: "M1040 692 L1085 667 L1120 702 L1168 752 L1160 780 L1040 780 Z" }] },
  { code: "2.27", areas: [{ title: "2.27", sub: "Collab.", count: 7, kind: "long", c: [1002, 620], label: [943, 575],
      d: "M938 562 L1000 557 L1070 582 L1062 640 L1035 690 L990 660 L938 655 Z" }] },
  { code: "2.28", areas: [{ title: "2.28", sub: "Collab.", count: 7, kind: "round", c: [985, 737], label: [943, 676],
      d: "M938 655 L990 660 L1035 690 L1030 780 L938 780 Z" }] },
  { code: "quiet-computer", areas: [
      { title: "Computers", count: 3, kind: "computer", c: [950, 915], cols: 3, label: [888, 866] },
      { title: "Computers", count: 4, kind: "computer", c: [1222, 985], cols: 2, label: [1162, 862] },
  ] },
  { code: "quiet-study", areas: [
      { title: "Study area", count: 4, kind: "study", c: [982, 1197], cols: 4, label: [914, 1150] },
      { title: "Study area", count: 3, kind: "study", c: [1192, 1197], cols: 3, label: [1124, 1150] },
  ] },
];

const STATUS_TEXT = { available: "Available", pending: "Claimed", occupied: "Occupied" };
const STATUS_PILL = { available: "green", pending: "yellow", occupied: "red" };

const map = document.getElementById("map");
const sheet = document.getElementById("sheet");
const sheetBody = document.getElementById("sheet-body");
const freeCount = document.getElementById("free-count");
const levelPill = document.getElementById("level-pill");
const activityList = document.getElementById("activity-list");
const conn = document.getElementById("conn");

const seatEls = new Map();
const areaFree = [];
const qrByClaim = new Map();

// Claim tokens for claims made from this browser (or opened on it via the QR
// link). Only the holder can check in or release, so only they see those buttons.
function claimToken(claimId) {
  try { return localStorage.getItem(`claimToken:${claimId}`); } catch { return null; }
}
function saveClaimToken(claimId, token) {
  try { localStorage.setItem(`claimToken:${claimId}`, token); } catch {}
}
let desks = [];
let desksById = new Map();
let selectedId = null;
let lastSheetSig = null;
let sheetMsg = "";
let built = false;
let activity = [];
// The signed-in account (handle only on the page; private fields are fetched
// only into the account dialog), and the live claims it owns.
let me = null;
let myClaims = new Set();
// True while a POST is in flight: buttons are disabled so a slow connection
// can't turn one tap into two requests.
let busy = false;

function svg(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.append(e);
  return e;
}

function zoneOf(id) {
  return id.slice(0, id.lastIndexOf("-"));
}

function numOf(id) {
  return id.slice(id.lastIndexOf("-") + 1);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function isMismatch(desk) {
  if (!desk.report) return false;
  return (
    (desk.report.status === "free" && desk.status !== "available") ||
    (desk.report.status === "taken" && desk.status === "available")
  );
}

function addSeat(parent, deskId, shape) {
  const g = svg("g", { class: "seat", tabindex: "0", role: "button", "data-id": deskId }, parent);
  let badgeX, badgeY, textX, textY;
  if (shape.type === "circle") {
    const { cx, cy } = shape;
    svg("circle", { class: "seat-ring", cx, cy, r: SEAT_R + 3.5 }, g);
    svg("circle", { class: "seat-body", cx, cy, r: SEAT_R }, g);
    badgeX = cx + SEAT_R * 0.75;
    badgeY = cy - SEAT_R * 0.75;
    textX = cx;
    textY = cy + 3;
  } else {
    const { x, y, w, h } = shape;
    svg("rect", { class: "seat-ring", x: x - 3.5, y: y - 3.5, width: w + 7, height: h + 7, rx: 6 }, g);
    svg("rect", { class: "seat-body", x, y, width: w, height: h, rx: 4 }, g);
    if (shape.monitor) {
      svg("rect", { class: "monitor", x: x + w * 0.2, y: y + 3, width: w * 0.6, height: 5, rx: 1 }, g);
    }
    badgeX = x + w - 1;
    badgeY = y + 1;
    textX = x + w / 2;
    textY = y + h / 2 + (shape.monitor ? 5.5 : 3);
  }
  const num = svg("text", { class: "seat-num", x: textX, y: textY }, g);
  num.textContent = numOf(deskId);
  const badge = svg("g", { class: "seat-badge" }, g);
  svg("circle", { class: "badge-bg", cx: badgeX, cy: badgeY, r: 4 }, badge);
  svg("circle", { class: "badge-dot", cx: badgeX, cy: badgeY, r: 2.2 }, badge);

  g.addEventListener("click", () => select(deskId));
  g.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      select(deskId);
    }
  });
  seatEls.set(deskId, g);
}

function buildArea(area, ids) {
  const g = svg("g", {}, map);
  if (area.d) svg("path", { class: "room", d: area.d }, g);
  const [lx, ly] = area.label;
  svg("text", { class: "room-title", x: lx, y: ly }, g).textContent = area.title;
  const free = svg("text", { class: "room-free", x: lx, y: ly + 9 }, g);
  areaFree.push({ el: free, ids });

  const [cx, cy] = area.c;
  const n = ids.length;
  if (area.kind === "round") {
    svg("circle", { class: "furniture", cx, cy, r: 12 }, g);
    ids.forEach((id, i) => {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
      addSeat(g, id, { type: "circle", cx: cx + Math.cos(a) * 24, cy: cy + Math.sin(a) * 24 });
    });
  } else if (area.kind === "long") {
    const top = Math.ceil(n / 2);
    const gap = 22;
    const tw = top * gap;
    svg("rect", { class: "furniture", x: cx - tw / 2, y: cy - 7, width: tw, height: 14, rx: 3 }, g);
    ids.forEach((id, i) => {
      const row = i < top ? 0 : 1;
      const count = row === 0 ? top : n - top;
      const k = row === 0 ? i : i - top;
      addSeat(g, id, { type: "circle", cx: cx + (k - (count - 1) / 2) * gap, cy: row === 0 ? cy - 18 : cy + 18 });
    });
  } else {
    const cols = Math.min(area.cols, n);
    const rows = Math.ceil(n / cols);
    const step = SQUARE + 8;
    const x0 = cx - ((cols - 1) * step) / 2 - SQUARE / 2;
    const y0 = cy - ((rows - 1) * step) / 2 - SQUARE / 2;
    ids.forEach((id, i) => {
      addSeat(g, id, {
        type: "rect",
        x: x0 + (i % cols) * step,
        y: y0 + Math.floor(i / cols) * step,
        w: SQUARE,
        h: SQUARE,
        monitor: area.kind === "computer",
      });
    });
  }
}

function buildMap() {
  for (const wing of WINGS) {
    svg("path", { class: `wing ${wing.fill}`, d: wing.d }, map);
    svg("text", { class: "wing-label", x: wing.label[0], y: wing.label[1] }, map).textContent = wing.name;
  }
  for (const f of FEATURES) {
    if (f.rect) {
      const [x, y, width, height] = f.rect;
      svg("rect", { class: f.cls, x, y, width, height, rx: 2 }, map);
    }
    if (f.text) {
      const [t, x, y] = f.text;
      svg("text", { class: f.cls && !f.rect ? f.cls : "core-label", x, y }, map).textContent = t;
    }
  }

  const idsByZone = new Map();
  for (const d of desks) {
    const z = zoneOf(d.id);
    if (!idsByZone.has(z)) idsByZone.set(z, []);
    idsByZone.get(z).push(d.id);
  }
  for (const zone of ZONES) {
    const ids = (idsByZone.get(zone.code) ?? []).sort((a, b) => Number(numOf(a)) - Number(numOf(b)));
    let at = 0;
    zone.areas.forEach((area, i) => {
      const last = i === zone.areas.length - 1;
      const take = last ? ids.slice(at) : ids.slice(at, at + area.count);
      at += take.length;
      buildArea(area, take);
    });
  }
  built = true;
}

function updateMap() {
  for (const desk of desks) {
    const g = seatEls.get(desk.id);
    if (!g) continue;
    const cls = ["seat", `seat--${desk.status}`];
    if (desk.report) cls.push(`seat--reported-${desk.report.status}`);
    if (isMismatch(desk)) cls.push("seat--mismatch");
    if (desk.id === selectedId) cls.push("seat--selected");
    g.setAttribute("class", cls.join(" "));
    const reportBit = desk.report ? `, reported ${desk.report.status}` : "";
    g.setAttribute("aria-label", `${desk.label}, ${desk.zone}, ${STATUS_TEXT[desk.status]}${reportBit}`);
  }

  for (const { el, ids } of areaFree) {
    const free = ids.filter((id) => desksById.get(id)?.status === "available").length;
    el.textContent = `${free}/${ids.length} free`;
  }

  const free = desks.filter((d) => d.status === "available").length;
  freeCount.textContent = `${free} of ${desks.length} desks free`;
  const ratio = desks.length ? free / desks.length : 0;
  const [label, tone] = ratio > 0.5 ? ["Quiet", "green"] : ratio > 0.15 ? ["Busy", "orange"] : ["Full", "red"];
  levelPill.textContent = label;
  levelPill.className = `pill pill--${tone}`;
  levelPill.hidden = false;
}

function ago(ts) {
  const m = Math.floor((Date.now() - ts) / 60000);
  return m < 1 ? "just now" : `${m} min ago`;
}

function clock(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function secondsLeft(ts) {
  return Math.max(0, Math.ceil((ts - Date.now()) / 1000));
}

function renderSheet(force = false) {
  const desk = selectedId ? desksById.get(selectedId) : null;
  if (!desk) {
    sheet.classList.remove("open");
    lastSheetSig = null;
    sheetBody.innerHTML = `<p class="placeholder">Tap a desk on the map to claim it or report what you see.</p>`;
    return;
  }
  const qr = desk.claim ? qrByClaim.get(desk.claim.id) : null;
  const mine = desk.claim ? Boolean(claimToken(desk.claim.id)) || myClaims.has(desk.claim.id) : false;
  const sig = JSON.stringify([desk, Boolean(qr), mine, sheetMsg, busy, me?.handle]);
  if (!force && sig === lastSheetSig) return;
  lastSheetSig = sig;

  const mismatch = isMismatch(desk);
  let main = "";
  if (desk.status === "available") {
    main = me
      ? `
      <p class="sub">You'll appear to others as <strong>${escapeHtml(me.handle)}</strong>.</p>
      <div class="actions"><button class="btn" data-action="claim">Claim</button></div>
      <p class="hint">Only claim a desk you're sitting at. You'll have 20 seconds to check in or it's released.</p>`
      : `
      <p class="sub">Sign in to claim this desk. You can still report what you see below without an account.</p>
      <div class="actions"><button class="btn" data-action="signin">Sign in to claim</button></div>`;
  } else if (desk.status === "pending") {
    main = `
      <p>Claimed by <strong>${escapeHtml(desk.claim.name)}</strong>. Check in within
      <strong data-countdown="${desk.claim.expiresAt}">${secondsLeft(desk.claim.expiresAt)}s</strong> or it's released.</p>
      ${mine && qr ? `<div class="qr"><img src="${qr}" alt="Check-in QR code" /></div>` : ""}
      ${mine ? `<div class="actions"><button class="btn" data-action="checkin">Check in</button></div>` : ""}`;
  } else {
    main = `
      <p><strong>${escapeHtml(desk.claim.name)}</strong> is here. Held until ${clock(desk.claim.expiresAt)}.</p>
      ${mine ? `<div class="actions"><button class="btn btn--ghost" data-action="release">I'm leaving</button></div>` : ""}`;
  }

  const report = desk.report
    ? `<p class="callout ${mismatch ? "callout--mismatch" : ""}">
        Someone reported this desk <strong>${desk.report.status}</strong>
        <span data-ago="${desk.report.createdAt}">${ago(desk.report.createdAt)}</span>.
        ${mismatch ? "That doesn't match its claim status." : ""}
      </p>`
    : "";

  sheetBody.innerHTML = `
    <div class="sheet-head">
      <div>
        <h2>${escapeHtml(desk.label)}</h2>
        <p class="sub">${escapeHtml(desk.zone)}</p>
      </div>
      <div class="sheet-head-right">
        <span class="pill pill--${STATUS_PILL[desk.status]}">${STATUS_TEXT[desk.status]}</span>
        <button class="sheet-close" data-action="close" aria-label="Close">×</button>
      </div>
    </div>
    ${report}
    ${main}
    ${sheetMsg ? `<p class="msg" role="alert">${escapeHtml(sheetMsg)}</p>` : ""}
    <hr class="divider" />
    <p class="hint">What do you actually see at this desk?</p>
    <div class="report-row">
      <button class="btn btn--ghost" data-action="report-free">Looks free</button>
      <button class="btn btn--ghost" data-action="report-taken">Looks taken</button>
    </div>`;
  sheet.classList.add("open");
  if (busy) {
    for (const btn of sheetBody.querySelectorAll("button[data-action]:not([data-action=close])")) {
      btn.disabled = true;
    }
  }
}

function select(id) {
  selectedId = id;
  sheetMsg = "";
  updateMap();
  renderSheet(true);
}

function deselect() {
  const seat = selectedId ? seatEls.get(selectedId) : null;
  selectedId = null;
  sheetMsg = "";
  updateMap();
  renderSheet(true);
  // Keyboard users land back on the desk they opened, not the top of the page.
  seat?.focus();
}

async function postJson(path, body) {
  // Give up after 10s rather than leave the buttons disabled forever.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: { error: "Couldn't reach the server. Check your connection and try again." } };
  } finally {
    clearTimeout(timer);
  }
}

async function act(action) {
  const desk = desksById.get(selectedId);
  if (!desk || busy) return;
  busy = true;
  sheetMsg = "";
  renderSheet(true);
  const deskPath = `/api/desks/${encodeURIComponent(desk.id)}`;
  let result = { ok: true, data: {} };
  if (action === "signin") {
    busy = false;
    renderSheet(true);
    openAccount("signin");
    return;
  }
  if (action === "claim") {
    result = await postJson(`${deskPath}/claim`, {});
    if (result.ok) {
      qrByClaim.set(result.data.id, result.data.qr);
      saveClaimToken(result.data.id, result.data.claimToken);
      myClaims.add(result.data.id);
    } else if (result.status === 401) {
      // Session expired since the page loaded.
      setMe(null);
    }
  } else if (action === "checkin" && desk.claim) {
    result = await postJson(`/api/claims/${desk.claim.id}/checkin`, { token: claimToken(desk.claim.id) });
  } else if (action === "release" && desk.claim) {
    result = await postJson(`/api/claims/${desk.claim.id}/release`, { token: claimToken(desk.claim.id) });
  } else if (action === "report-free" || action === "report-taken") {
    result = await postJson(`${deskPath}/report`, { status: action === "report-free" ? "free" : "taken" });
  }
  busy = false;
  sheetMsg = result.ok ? "" : (result.data.error ?? "Something went wrong, try again.");
  renderSheet(true);
}

sheetBody.addEventListener("click", (ev) => {
  const btn = ev.target.closest("[data-action]");
  if (!btn) return;
  if (btn.dataset.action === "close") deselect();
  else act(btn.dataset.action);
});

document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && selectedId) deselect();
});

setInterval(() => {
  for (const el of sheetBody.querySelectorAll("[data-countdown]")) {
    el.textContent = `${secondsLeft(Number(el.dataset.countdown))}s`;
  }
  for (const el of sheetBody.querySelectorAll("[data-ago]")) {
    el.textContent = ago(Number(el.dataset.ago));
  }
}, 250);

const ACTIVITY_TEXT = {
  claim: (e) => `<strong>${escapeHtml(e.actor)}</strong> claimed`,
  checkin: (e) => `<strong>${escapeHtml(e.actor)}</strong> checked in at`,
  release: (e) => `<strong>${escapeHtml(e.actor)}</strong> left`,
  expire: (e) =>
    e.detail === "hold-ended"
      ? `<strong>${escapeHtml(e.actor)}</strong>'s 2h hold ended on`
      : `<strong>${escapeHtml(e.actor)}</strong> didn't check in, released`,
  report: (e) => `<strong>${escapeHtml(e.actor)}</strong> reported ${e.detail === "free" ? "free" : "taken"}:`,
};

function when(ts) {
  const d = new Date(ts);
  const today = new Date().toDateString() === d.toDateString();
  return today ? clock(ts) : `${d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })} ${clock(ts)}`;
}

function renderActivity() {
  if (activity.length === 0) {
    activityList.innerHTML = `<li class="placeholder">Nothing yet. Claim a desk or report one to start the log.</li>`;
    return;
  }
  activityList.innerHTML = activity
    .map((e) => {
      const desk = desksById.get(e.deskId);
      const where = desk ? `${desk.label}, ${desk.zone}` : e.deskId;
      return `<li class="act act--${e.kind}${e.kind === "report" ? `-${e.detail}` : ""}">
        <time datetime="${new Date(e.at).toISOString()}">${when(e.at)}</time>
        <span>${ACTIVITY_TEXT[e.kind]?.(e) ?? escapeHtml(e.kind)} ${escapeHtml(where)}</span>
      </li>`;
    })
    .join("");
}

function setConn(state) {
  conn.className = `conn conn--${state}`;
  conn.textContent = { live: "Live", connecting: "Connecting…", offline: "Reconnecting…" }[state];
}

function apply(payload) {
  const snapshot = payload.desks;
  activity = payload.activity;
  desks = snapshot;
  desksById = new Map(desks.map((d) => [d.id, d]));
  if (!built) buildMap();
  updateMap();
  renderSheet();
  renderActivity();
}

// On reconnect the server sends a full snapshot first, so nothing missed
// while offline is lost; the indicator tells people the map may be stale.
// The server pings every 15s, so 35s of silence means the connection is dead
// even if the browser hasn't noticed (it often doesn't on a dropped network).
const STALE_MS = 35_000;
let source = null;
let lastHeard = 0;

function reconnect() {
  setConn("offline");
  source?.close();
  source = null;
  setTimeout(connectEvents, 2000);
}

function connectEvents() {
  if (source) return;
  source = new EventSource("/api/events");
  lastHeard = Date.now();
  const heard = () => {
    lastHeard = Date.now();
    setConn("live");
  };
  source.onopen = () => {
    // A "couldn't reach the server" left from while offline is now stale.
    if (sheetMsg.startsWith("Couldn't reach")) {
      sheetMsg = "";
      renderSheet(true);
    }
    heard();
  };
  source.addEventListener("ping", heard);
  source.onmessage = (ev) => {
    heard();
    apply(JSON.parse(ev.data));
  };
  source.onerror = reconnect;
}

setInterval(() => {
  if (source && Date.now() - lastHeard > STALE_MS) reconnect();
}, 5000);
window.addEventListener("offline", reconnect);
window.addEventListener("online", () => {
  if (!source) connectEvents();
});

// ---- Accounts ----
const accountBtn = document.getElementById("account-btn");
const accountDialog = document.getElementById("account-dialog");
const accountBody = document.getElementById("account-body");

function setMe(next, liveClaimIds = []) {
  me = next;
  myClaims = new Set(liveClaimIds);
  accountBtn.textContent = me ? me.handle : "Sign in";
  accountBtn.setAttribute("aria-label", me ? `Your account (${me.handle})` : "Sign in or create an account");
  renderSheet(true);
}

async function loadMe() {
  try {
    const res = await fetch("/api/me");
    if (!res.ok) return setMe(null);
    const data = await res.json();
    setMe(data.user, data.liveClaimIds);
    return data.user ? data : null;
  } catch {
    return null;
  }
}

const PRIVACY = `
  <details class="privacy">
    <summary>What's collected and who sees it</summary>
    <ul>
      <li><strong>Everyone</strong> sees only your handle, on desks you claim and in the activity log. Reports always show as "Anonymous".</li>
      <li><strong>Only you</strong> can see your full name and student ID (under your account). They're stored on this app's server for record keeping and are never shown to other users, written to logs, or sent to anyone else.</li>
      <li>Your student ID isn't verified against ANU's systems.</li>
      <li>Your passphrase is stored only as a salted hash.</li>
      <li>You can delete your account at any time. That erases your name, student ID and passphrase; your past actions stay in the log as "deleted user".</li>
      <li>This is a student project (COMP4020/8020), not an official ANU service.</li>
    </ul>
  </details>`;

function renderAccount(mode, msg = "", data = null) {
  if (mode === "me" && data) {
    const u = data.user;
    const hist = data.history.length
      ? data.history
          .map((e) => {
            const desk = desksById.get(e.deskId);
            const where = desk ? `${desk.label}, ${desk.zone}` : e.deskId;
            const what = e.kind === "report" ? `reported ${e.detail}` : { claim: "claimed", checkin: "checked in", release: "released", expire: e.detail === "hold-ended" ? "hold ended" : "didn't check in" }[e.kind];
            return `<li><time>${when(e.at)}</time> <span>${escapeHtml(what ?? e.kind)}: ${escapeHtml(where)}</span></li>`;
          })
          .join("")
      : `<li class="placeholder">Nothing yet.</li>`;
    accountBody.innerHTML = `
      <h2 id="account-title">Your account</h2>
      <dl class="me">
        <dt>Handle (public)</dt><dd>${escapeHtml(u.handle)}</dd>
        <dt>Full name (private)</dt><dd>${escapeHtml(u.fullName)}</dd>
        <dt>Student ID (private)</dt><dd>${escapeHtml(u.studentId)}</dd>
        <dt>Member since</dt><dd>${new Date(u.createdAt).toLocaleDateString()}</dd>
      </dl>
      <h3>Your history</h3>
      <ol class="activity-list me-history">${hist}</ol>
      ${msg ? `<p class="msg" role="alert">${escapeHtml(msg)}</p>` : ""}
      <div class="actions actions--split">
        <button class="btn btn--danger" data-acct="delete">Delete my account</button>
        <button class="btn btn--ghost" data-acct="logout">Sign out</button>
      </div>`;
    return;
  }
  const signin = mode === "signin";
  accountBody.innerHTML = `
    <div class="tabs" role="tablist">
      <button role="tab" aria-selected="${signin}" data-acct="tab-signin">Sign in</button>
      <button role="tab" aria-selected="${!signin}" data-acct="tab-signup">Create account</button>
    </div>
    <h2 id="account-title" class="visually-hidden">${signin ? "Sign in" : "Create account"}</h2>
    <form id="account-form" novalidate>
      <label class="field" for="f-handle">Handle${signin ? "" : " (shown to others)"}</label>
      <input id="f-handle" name="handle" class="input" autocomplete="username" required maxlength="24" />
      ${
        signin
          ? ""
          : `
      <label class="field" for="f-name">Full name (private)</label>
      <input id="f-name" name="fullName" class="input" autocomplete="name" required maxlength="80" />
      <label class="field" for="f-sid">Student ID (private)</label>
      <input id="f-sid" name="studentId" class="input" placeholder="u1234567" required maxlength="8" autocapitalize="none" />`
      }
      <label class="field" for="f-pass">Passphrase${signin ? "" : " (10+ characters)"}</label>
      <input id="f-pass" name="passphrase" type="password" class="input" autocomplete="${signin ? "current-password" : "new-password"}" required />
      ${
        signin
          ? ""
          : `${PRIVACY}
      <label class="check"><input type="checkbox" name="consent" required /> I've read the above and agree to my name and student ID being stored for record keeping.</label>`
      }
      ${msg ? `<p class="msg" role="alert">${escapeHtml(msg)}</p>` : ""}
      <div class="actions"><button class="btn" type="submit">${signin ? "Sign in" : "Create account"}</button></div>
    </form>`;
  accountBody.querySelector("#f-handle")?.focus();
}

let accountMode = "signin";
async function openAccount(mode) {
  accountMode = me ? "me" : mode;
  if (accountMode === "me") {
    const data = await loadMe();
    if (!data) accountMode = "signin";
    else renderAccount("me", "", data);
  }
  if (accountMode !== "me") renderAccount(accountMode);
  if (!accountDialog.open) accountDialog.showModal();
}

accountBtn.addEventListener("click", () => openAccount("signin"));

accountBody.addEventListener("click", async (ev) => {
  const btn = ev.target.closest("[data-acct]");
  if (!btn) return;
  const what = btn.dataset.acct;
  if (what === "tab-signin" || what === "tab-signup") {
    accountMode = what === "tab-signin" ? "signin" : "signup";
    renderAccount(accountMode);
  } else if (what === "logout") {
    await postJson("/api/logout");
    setMe(null);
    accountDialog.close();
  } else if (what === "delete") {
    if (!confirm("Delete your account? This erases your name, student ID and passphrase and can't be undone. Your past actions stay in the log as \"deleted user\".")) return;
    btn.disabled = true;
    try {
      const res = await fetch("/api/me", { method: "DELETE" });
      if (!res.ok) throw new Error();
      setMe(null);
      accountDialog.close();
    } catch {
      btn.disabled = false;
      renderAccount("me", "Couldn't delete your account. Try again.", await loadMe());
    }
  }
});

accountBody.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const form = ev.target;
  const f = new FormData(form);
  const submit = form.querySelector("button[type=submit]");
  submit.disabled = true;
  const body =
    accountMode === "signin"
      ? { handle: f.get("handle"), passphrase: f.get("passphrase") }
      : {
          handle: f.get("handle"),
          fullName: f.get("fullName"),
          studentId: f.get("studentId"),
          passphrase: f.get("passphrase"),
          consent: f.get("consent") === "on",
        };
  const result = await postJson(accountMode === "signin" ? "/api/login" : "/api/signup", body);
  if (!result.ok) {
    const keep = Object.fromEntries([...f.entries()].filter(([k]) => k !== "passphrase"));
    renderAccount(accountMode, result.data.error ?? "Something went wrong, try again.");
    for (const [k, v] of Object.entries(keep)) {
      const el = accountBody.querySelector(`[name="${k}"]`);
      if (el && el.type !== "checkbox") el.value = v;
      else if (el) el.checked = v === "on";
    }
    return;
  }
  await loadMe();
  accountDialog.close();
});

loadMe();
renderSheet();
connectEvents();
