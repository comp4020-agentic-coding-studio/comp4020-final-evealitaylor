const NS = "http://www.w3.org/2000/svg";
const SEAT_R = 18;

// Made-up floor layout: zone positions are illustrative, not from a survey.
const ROOMS = [
  { code: "2.22", title: "2.22", sub: "Collaborative", kind: "round", x: 25, y: 25, w: 270, h: 200 },
  { code: "2.23", title: "2.23", sub: "Collaborative", kind: "long", x: 305, y: 25, w: 270, h: 200 },
  { code: "2.24", title: "2.24", sub: "Collaborative", kind: "long", x: 25, y: 240, w: 270, h: 200 },
  { code: "2.25", title: "2.25", sub: "Collaborative", kind: "round", x: 305, y: 240, w: 270, h: 200 },
  { code: "2.27", title: "2.27", sub: "Collaborative", kind: "round", x: 25, y: 580, w: 270, h: 200 },
  { code: "2.28", title: "2.28", sub: "Collaborative", kind: "long", x: 305, y: 580, w: 270, h: 200 },
  { code: "quiet-study", title: "Quiet Zone", sub: "Study carrels", kind: "carrel", x: 25, y: 795, w: 550, h: 165 },
  { code: "quiet-computer", title: "Quiet Zone", sub: "Computers", kind: "computer", x: 25, y: 975, w: 550, h: 165 },
];

const CORE = [
  { label: "Stairs", x: 25, w: 130 },
  { label: "Lifts", x: 165, w: 100 },
  { label: "Toilets", x: 455, w: 120 },
];

const STATUS_TEXT = { available: "Available", pending: "Claimed", occupied: "Occupied" };
const STATUS_PILL = { available: "green", pending: "yellow", occupied: "red" };

const map = document.getElementById("map");
const sheet = document.getElementById("sheet");
const sheetBody = document.getElementById("sheet-body");
const freeCount = document.getElementById("free-count");
const levelPill = document.getElementById("level-pill");

const seatEls = new Map();
const roomFreeEls = new Map();
const qrByClaim = new Map();
let desks = [];
let desksById = new Map();
let selectedId = null;
let lastSheetSig = null;
let sheetMsg = "";
let built = false;

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
    svg("circle", { class: "seat-ring", cx, cy, r: SEAT_R + 6 }, g);
    svg("circle", { class: "seat-body", cx, cy, r: SEAT_R }, g);
    badgeX = cx + SEAT_R * 0.75;
    badgeY = cy - SEAT_R * 0.75;
    textX = cx;
    textY = cy + 5;
  } else {
    const { x, y, w, h } = shape;
    svg("rect", { class: "seat-ring", x: x - 6, y: y - 6, width: w + 12, height: h + 12, rx: 11 }, g);
    svg("rect", { class: "seat-body", x, y, width: w, height: h, rx: 8 }, g);
    if (shape.monitor) {
      svg("rect", { class: "monitor", x: x + w * 0.22, y: y + 7, width: w * 0.56, height: 11, rx: 2 }, g);
    }
    badgeX = x + w - 1;
    badgeY = y + 1;
    textX = x + w / 2;
    textY = y + h / 2 + (shape.monitor ? 12 : 5);
  }
  const num = svg("text", { class: "seat-num", x: textX, y: textY }, g);
  num.textContent = numOf(deskId);
  const badge = svg("g", { class: "seat-badge" }, g);
  svg("circle", { class: "badge-bg", cx: badgeX, cy: badgeY, r: 7.5 }, badge);
  svg("circle", { class: "badge-dot", cx: badgeX, cy: badgeY, r: 4 }, badge);

  g.addEventListener("click", () => select(deskId));
  g.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      select(deskId);
    }
  });
  seatEls.set(deskId, g);
}

function buildRoom(room, ids) {
  const g = svg("g", {}, map);
  svg("rect", { class: "room", x: room.x, y: room.y, width: room.w, height: room.h, rx: 14 }, g);
  svg("text", { class: "room-title", x: room.x + 14, y: room.y + 28 }, g).textContent = room.title;
  svg("text", { class: "room-sub", x: room.x + 14, y: room.y + 45 }, g).textContent = room.sub;
  const free = svg("text", { class: "room-free", x: room.x + 14, y: room.y + 61 }, g);
  roomFreeEls.set(room.code, free);

  const n = ids.length;
  if (room.kind === "round") {
    const cx = room.x + room.w / 2 + 22;
    const cy = room.y + room.h / 2 + 4;
    svg("circle", { class: "furniture", cx, cy, r: 38 }, g);
    ids.forEach((id, i) => {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
      addSeat(g, id, { type: "circle", cx: cx + Math.cos(a) * 64, cy: cy + Math.sin(a) * 64 });
    });
  } else if (room.kind === "long") {
    const top = Math.ceil(n / 2);
    const gap = 46;
    const cx = room.x + room.w / 2 + 18;
    const cy = room.y + room.h / 2 + 18;
    const tw = top * gap + 10;
    svg("rect", { class: "furniture", x: cx - tw / 2, y: cy - 22, width: tw, height: 44, rx: 6 }, g);
    ids.forEach((id, i) => {
      const row = i < top ? 0 : 1;
      const count = row === 0 ? top : n - top;
      const k = row === 0 ? i : i - top;
      addSeat(g, id, {
        type: "circle",
        cx: cx + (k - (count - 1) / 2) * gap,
        cy: row === 0 ? cy - 46 : cy + 46,
      });
    });
  } else {
    const s = 56;
    const gap = Math.min(18, (room.w - 60 - n * s) / Math.max(1, n - 1));
    const total = n * s + (n - 1) * gap;
    const x0 = room.x + (room.w - total) / 2;
    const y0 = room.y + 82;
    svg("rect", { class: "furniture", x: x0 - 8, y: y0 - 14, width: total + 16, height: 8, rx: 3 }, g);
    ids.forEach((id, i) => {
      addSeat(g, id, { type: "rect", x: x0 + i * (s + gap), y: y0, w: s, h: s, monitor: room.kind === "computer" });
    });
  }
}

function buildMap() {
  svg("rect", { class: "building", x: 10, y: 10, width: 580, height: 1140, rx: 24 }, map);
  for (const c of CORE) {
    svg("rect", { class: "core", x: c.x, y: 455, width: c.w, height: 110, rx: 10 }, map);
    svg("text", { class: "core-label", x: c.x + c.w / 2, y: 515 }, map).textContent = c.label;
  }
  svg("text", { class: "core-label", x: 360, y: 505 }, map).textContent = "Entry";
  svg("text", { class: "core-label", x: 360, y: 528 }, map).textContent = "↓";

  const idsByZone = new Map();
  for (const d of desks) {
    const z = zoneOf(d.id);
    if (!idsByZone.has(z)) idsByZone.set(z, []);
    idsByZone.get(z).push(d.id);
  }
  for (const room of ROOMS) {
    const ids = (idsByZone.get(room.code) ?? []).sort((a, b) => Number(numOf(a)) - Number(numOf(b)));
    buildRoom(room, ids);
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

  for (const room of ROOMS) {
    const zoneDesks = desks.filter((d) => zoneOf(d.id) === room.code);
    const free = zoneDesks.filter((d) => d.status === "available").length;
    const el = roomFreeEls.get(room.code);
    if (el) el.textContent = `${free}/${zoneDesks.length} free`;
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
  const sig = JSON.stringify([desk, Boolean(qr), sheetMsg]);
  if (!force && sig === lastSheetSig) return;
  lastSheetSig = sig;

  const active = document.activeElement;
  const restoreName = active && active.id === "claim-name" ? active.selectionStart : null;

  const mismatch = isMismatch(desk);
  let main = "";
  if (desk.status === "available") {
    main = `
      <label class="field" for="claim-name">Your name or pseudonym</label>
      <input id="claim-name" class="input" type="text" maxlength="40" placeholder="e.g. Sam" value="${escapeHtml(localStorage.getItem("deskName") ?? "")}" />
      <div class="actions"><button class="btn" data-action="claim">Claim</button></div>
      <p class="hint">Only claim a desk you're sitting at. You'll have 20 seconds to check in or it's released.</p>`;
  } else if (desk.status === "pending") {
    main = `
      <p>Claimed by <strong>${escapeHtml(desk.claim.name)}</strong>. Check in within
      <strong data-countdown="${desk.claim.expiresAt}">${secondsLeft(desk.claim.expiresAt)}s</strong> or it's released.</p>
      ${qr ? `<div class="qr"><img src="${qr}" alt="Check-in QR code" /></div>` : ""}
      <div class="actions"><button class="btn" data-action="checkin">Check in</button></div>`;
  } else {
    main = `
      <p><strong>${escapeHtml(desk.claim.name)}</strong> is here. Held until ${clock(desk.claim.expiresAt)}.</p>
      <div class="actions"><button class="btn btn--ghost" data-action="release">I'm leaving</button></div>`;
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
    ${sheetMsg ? `<p class="msg">${escapeHtml(sheetMsg)}</p>` : ""}
    <hr class="divider" />
    <p class="hint">What do you actually see at this desk?</p>
    <div class="report-row">
      <button class="btn btn--ghost" data-action="report-free">Looks free</button>
      <button class="btn btn--ghost" data-action="report-taken">Looks taken</button>
    </div>`;
  sheet.classList.add("open");

  const nameInput = document.getElementById("claim-name");
  if (nameInput) {
    nameInput.addEventListener("input", () => localStorage.setItem("deskName", nameInput.value));
    if (restoreName !== null) {
      nameInput.focus();
      nameInput.setSelectionRange(restoreName, restoreName);
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
  selectedId = null;
  sheetMsg = "";
  updateMap();
  renderSheet(true);
}

async function postJson(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

async function act(action) {
  const desk = desksById.get(selectedId);
  if (!desk) return;
  const deskPath = `/api/desks/${encodeURIComponent(desk.id)}`;
  let result = { ok: true, data: {} };
  if (action === "claim") {
    const name = document.getElementById("claim-name")?.value ?? "";
    localStorage.setItem("deskName", name);
    result = await postJson(`${deskPath}/claim`, { name });
    if (result.ok) qrByClaim.set(result.data.id, result.data.qr);
  } else if (action === "checkin" && desk.claim) {
    result = await postJson(`/api/claims/${desk.claim.id}/checkin`);
  } else if (action === "release" && desk.claim) {
    result = await postJson(`/api/claims/${desk.claim.id}/release`);
  } else if (action === "report-free" || action === "report-taken") {
    result = await postJson(`${deskPath}/report`, { status: action === "report-free" ? "free" : "taken" });
  }
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

function apply(snapshot) {
  desks = snapshot;
  desksById = new Map(desks.map((d) => [d.id, d]));
  if (!built) buildMap();
  updateMap();
  renderSheet();
}

function connectEvents() {
  const source = new EventSource("/api/events");
  source.onmessage = (ev) => apply(JSON.parse(ev.data));
  source.onerror = () => {
    source.close();
    setTimeout(connectEvents, 2000);
  };
}

renderSheet();
connectEvents();
