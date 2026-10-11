const board = document.getElementById("board");
const nameInput = document.getElementById("name");
const dialog = document.getElementById("checkin-dialog");
const qrImg = document.getElementById("checkin-qr");
const checkinLink = document.getElementById("checkin-link");
document.getElementById("checkin-close").addEventListener("click", () => dialog.close());

nameInput.value = localStorage.getItem("deskName") ?? "";
nameInput.addEventListener("change", () => {
  localStorage.setItem("deskName", nameInput.value);
});

function groupByZone(desks) {
  const zones = new Map();
  for (const desk of desks) {
    if (!zones.has(desk.zone)) zones.set(desk.zone, []);
    zones.get(desk.zone).push(desk);
  }
  return zones;
}

function deskCard(desk) {
  const el = document.createElement("article");
  el.className = `desk desk--${desk.status}`;

  const mismatch =
    desk.report &&
    ((desk.report.status === "free" && desk.status !== "available") ||
      (desk.report.status === "taken" && desk.status === "available"));
  if (mismatch) el.classList.add("desk--mismatch");

  const claimLine =
    desk.status === "available"
      ? ""
      : `<p class="desk-claim">${desk.claim.checkedIn ? "occupied by" : "claimed by"} ${escapeHtml(desk.claim.name)}</p>`;

  const reportLine = desk.report
    ? `<p class="desk-report">reported ${desk.report.status}${mismatch ? " — doesn't match booking" : ""}</p>`
    : "";

  el.innerHTML = `
    <h3>${escapeHtml(desk.label)}</h3>
    <p class="desk-status">${desk.status}</p>
    ${claimLine}
    ${reportLine}
    <div class="desk-actions"></div>
  `;

  const actions = el.querySelector(".desk-actions");
  if (desk.status === "available") {
    const claimBtn = button("claim this desk", () => claimDesk(desk.id));
    actions.append(claimBtn);
  } else if (desk.claim && !desk.claim.checkedIn) {
    actions.append(button("check in", () => checkin(desk.claim.id)));
  } else if (desk.claim && desk.claim.checkedIn) {
    actions.append(button("I'm leaving", () => release(desk.claim.id)));
  }
  actions.append(button("report free", () => report(desk.id, "free")));
  actions.append(button("report taken", () => report(desk.id, "taken")));

  return el;
}

function button(label, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function render(desks) {
  board.innerHTML = "";
  for (const [zone, deskList] of groupByZone(desks)) {
    const section = document.createElement("section");
    section.className = "zone";
    section.innerHTML = `<h2>${escapeHtml(zone)}</h2>`;
    const grid = document.createElement("div");
    grid.className = "zone-grid";
    for (const desk of deskList) grid.append(deskCard(desk));
    section.append(grid);
    board.append(section);
  }
}

async function claimDesk(deskId) {
  const res = await fetch(`/api/desks/${encodeURIComponent(deskId)}/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: nameInput.value }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    alert(body.error ?? "couldn't claim that desk");
    return;
  }
  const claim = await res.json();
  qrImg.src = claim.qr;
  checkinLink.href = claim.checkinUrl;
  dialog.showModal();
}

async function checkin(claimId) {
  const res = await fetch(`/api/claims/${claimId}/checkin`, { method: "POST" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    alert(body.error ?? "couldn't check in");
  }
}

async function release(claimId) {
  await fetch(`/api/claims/${claimId}/release`, { method: "POST" });
}

async function report(deskId, status) {
  await fetch(`/api/desks/${encodeURIComponent(deskId)}/report`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status }),
  });
}

async function loadInitial() {
  const res = await fetch("/api/desks");
  render(await res.json());
}

function connectEvents() {
  const source = new EventSource("/api/events");
  source.onmessage = (ev) => render(JSON.parse(ev.data));
  source.onerror = () => {
    source.close();
    setTimeout(connectEvents, 2000);
  };
}

loadInitial();
connectEvents();
