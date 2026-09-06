// Point this at wherever your backend (uvicorn) is actually running.
// Using the full address (not a relative "/api") means this frontend
// can be served by a completely separate server/port — e.g. VS Code
// Live Server — instead of being served by the backend itself.
const API = "http://127.0.0.1:8000/api";

const CATEGORIES = [
  "Food & Dining", "Groceries", "Transport", "Shopping", "Bills & Utilities",
  "Rent & Housing", "Entertainment", "Health & Fitness", "Travel",
  "Education", "Salary / Income", "Transfers", "Other",
];

const GAUGE_HORIZON_DAYS = 60; // full-scale reading on the dial
const ARC_LENGTH = 308; // matches the pre-measured semicircle path length in CSS

let categoryChart = null;
let trendChart = null;
let currentCurrency = "₹";
let selectedType = "expense";
let ledgerFilter = "all";
let ledgerSearchTerm = "";
let allTxns = [];

// ---------- init ----------

document.addEventListener("DOMContentLoaded", () => {
  populateCategorySelects();
  buildGaugeTicks();
  document.getElementById("txnDate").valueAsDate = new Date();

  document.getElementById("txnForm").addEventListener("submit", onAddTransaction);
  document.getElementById("settingsForm").addEventListener("submit", onSaveSettings);
  document.getElementById("categoryBudgetForm").addEventListener("submit", onSaveCategoryBudget);
  document.getElementById("openSettings").addEventListener("click", openSettingsDrawer);
  document.getElementById("closeSettings").addEventListener("click", closeSettingsDrawer);
  document.getElementById("drawerBackdrop").addEventListener("click", closeSettingsDrawer);

  document.querySelectorAll("#typeSegment .segmented-btn").forEach((btn) => {
    btn.addEventListener("click", () => setSelectedType(btn.dataset.type));
  });
  document.querySelectorAll("#filterSegment .segmented-btn").forEach((btn) => {
    btn.addEventListener("click", () => setLedgerFilter(btn.dataset.filter));
  });
  document.getElementById("ledgerSearch").addEventListener("input", (e) => {
    ledgerSearchTerm = e.target.value.trim().toLowerCase();
    renderLedger();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeSettingsDrawer();
  });

  refreshAll();
});

function populateCategorySelects() {
  const txnSel = document.getElementById("txnCategory");
  const cbSel = document.getElementById("cbCategory");
  CATEGORIES.forEach((c) => {
    const o1 = document.createElement("option");
    o1.value = c; o1.textContent = c;
    txnSel.appendChild(o1);
    const o2 = document.createElement("option");
    o2.value = c; o2.textContent = c;
    cbSel.appendChild(o2);
  });
}

function buildGaugeTicks() {
  const g = document.getElementById("gaugeTicks");
  const cx = 120, cy = 115, rOuter = 98, rInner = 88;
  const steps = 6;
  for (let i = 0; i <= steps; i++) {
    const angleDeg = -180 + (i / steps) * 180; // -180 (left) .. 0 (right), 0 = pointing up in SVG's y-down space
    const rad = (angleDeg * Math.PI) / 180;
    const x1 = cx + rOuter * Math.cos(rad);
    const y1 = cy + rOuter * Math.sin(rad);
    const x2 = cx + rInner * Math.cos(rad);
    const y2 = cy + rInner * Math.sin(rad);
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", x1.toFixed(1));
    line.setAttribute("y1", y1.toFixed(1));
    line.setAttribute("x2", x2.toFixed(1));
    line.setAttribute("y2", y2.toFixed(1));
    line.setAttribute("class", "gauge-tick");
    g.appendChild(line);
  }
}

// ---------- data refresh ----------

async function refreshAll() {
  let dashboard, txns, catBudgets, settings;
  try {
    [dashboard, txns, catBudgets, settings] = await Promise.all([
      fetchJSON(`${API}/dashboard`),
      fetchJSON(`${API}/transactions`),
      fetchJSON(`${API}/category-budgets`),
      fetchJSON(`${API}/settings`),
    ]);
  } catch (err) {
    toast(err.message || "Couldn't reach the server", true);
    return;
  }

  currentCurrency = dashboard.summary.currency || "₹";
  allTxns = txns;

  renderStats(dashboard.summary);
  renderBrokeDate(dashboard.broke_date, dashboard.summary.current_balance);
  safely(() => renderCategoryChart(dashboard.summary.category_breakdown));
  safely(() => renderMonthlyMetric(dashboard.summary));
  safely(() => renderTrendChart(dashboard.summary.daily_trend, dashboard.summary));
  renderAlerts(dashboard.alerts);
  renderLedger();
  renderCategoryBudgetList(catBudgets, dashboard.summary.category_breakdown);

  document.getElementById("setBalance").value = settings.starting_balance;
  document.getElementById("setBudget").value = settings.monthly_budget;
  document.getElementById("setCurrency").value = settings.currency;
}

function safely(fn) {
  try { fn(); } catch (e) { console.error("Chart render skipped:", e); }
}

async function fetchJSON(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || "Request failed");
  }
  return res.json();
}

function fmtMoney(n) {
  const num = Number(n || 0);
  return `${currentCurrency}${num.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

// ---------- rendering ----------

function renderStats(summary) {
  document.getElementById("hdrBalance").textContent = fmtMoney(summary.current_balance);
  document.getElementById("statToday").textContent = fmtMoney(summary.today_spent);
  document.getElementById("statWeek").textContent = fmtMoney(summary.week_spent);
  document.getElementById("statMonth").textContent = fmtMoney(summary.month_spent);
  document.getElementById("statIncome").textContent = fmtMoney(summary.month_income);
}

function renderBrokeDate(prediction, balance) {
  const primary = prediction.primary || {};
  const big = document.getElementById("brokeDateBig");
  const sub = document.getElementById("brokeDateSub");
  const meta = document.getElementById("heroMeta");
  const gaugeFill = document.getElementById("gaugeFill");
  const needle = document.getElementById("gaugeNeedle");
  const gaugeDays = document.getElementById("gaugeDays");
  const runwayToken = document.getElementById("runwayToken");

  function setDial(pct, colorVar) {
    const clamped = Math.max(0, Math.min(1, pct));
    gaugeFill.style.stroke = `var(${colorVar})`;
    gaugeFill.style.strokeDashoffset = ARC_LENGTH - ARC_LENGTH * clamped;
    const angleDeg = -90 + clamped * 180;
    needle.style.transform = `rotate(${angleDeg}deg)`;
    runwayToken.style.left = `${clamped * 100}%`;
  }

  meta.textContent = "";

  if (!primary.broke_date) {
    if (primary.status === "safe") {
      big.textContent = "You're in the clear";
      big.style.color = "var(--green)";
      sub.textContent = "Your income currently covers or exceeds your spending — no broke date on the horizon.";
      gaugeDays.textContent = "∞";
      setDial(1, "--green");
    } else {
      big.textContent = "Not enough data yet";
      big.style.color = "var(--text)";
      sub.textContent = "Log a few days of transactions and a starting balance to get your first prediction.";
      gaugeDays.textContent = "—";
      setDial(0, "--muted-2");
    }
    return;
  }

  const dateObj = new Date(primary.broke_date + "T00:00:00");
  const formatted = dateObj.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
  big.textContent = formatted;

  const days = primary.days_remaining;
  const methodLabel = primary.method === "trend" ? "trend model" : "baseline estimate";
  sub.textContent = `${days} day${days === 1 ? "" : "s"} of runway left at your current spending pace.`;
  if (primary.method === "trend" && typeof primary.confidence_r2 === "number") {
    meta.textContent = `${methodLabel} · confidence r² ${primary.confidence_r2.toFixed(2)}`;
  } else {
    meta.textContent = methodLabel;
  }

  let colorVar = "--green";
  if (days <= 7) colorVar = "--red";
  else if (days <= 21) colorVar = "--amber";
  big.style.color = `var(${colorVar})`;

  const pct = days / GAUGE_HORIZON_DAYS;
  setDial(pct, colorVar);
  gaugeDays.textContent = Math.round(days);
}

function renderCategoryChart(breakdown) {
  const entries = Object.entries(breakdown || {}).sort((a, b) => b[1] - a[1]);
  const emptyEl = document.getElementById("categoryEmpty");
  const canvas = document.getElementById("categoryChart");

  if (entries.length === 0) {
    emptyEl.style.display = "block";
    canvas.style.display = "none";
    return;
  }
  emptyEl.style.display = "none";
  canvas.style.display = "block";

  const palette = ["#c9a24b", "#35c48a", "#e2543f", "#5f8fd9", "#a679c4", "#3fb8bf", "#d98a4a", "#8b909c", "#6f8f4f", "#b6647a"];

  if (categoryChart) categoryChart.destroy();
  categoryChart = new Chart(canvas, {
    type: "pie",
    data: {
      labels: entries.map((e) => e[0]),
      datasets: [{
        data: entries.map((e) => e[1]),
        backgroundColor: entries.map((_, i) => palette[i % palette.length]),
        borderColor: "#12161d",
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: "right",
          labels: { color: "#8c95a3", font: { family: "Inter", size: 11.5 }, boxWidth: 12, padding: 10 },
        },
        tooltip: {
          callbacks: { label: (ctx) => `${ctx.label}: ${fmtMoney(ctx.parsed)}` },
        },
      },
    },
  });
}

function renderMonthlyMetric(summary) {
  const monthlyBudget = summary.monthly_budget || 0;
  const monthSpent = summary.month_spent || 0;

  document.getElementById("monthlyBigNumber").textContent = fmtMoney(monthSpent);

  const deltaEl = document.getElementById("monthlyDelta");
  const arrowEl = document.getElementById("monthlyDeltaArrow");
  const amountEl = document.getElementById("monthlyDeltaAmount");
  const pctEl = document.getElementById("monthlyDeltaPct");
  const subEl = document.getElementById("monthlyDeltaLabel");

  if (!monthlyBudget) {
    deltaEl.className = "metric-delta";
    arrowEl.textContent = "";
    amountEl.textContent = "";
    pctEl.textContent = "";
    subEl.textContent = "Set a monthly budget to see variance";
    return;
  }

  const variance = monthSpent - monthlyBudget;
  const pct = (variance / monthlyBudget) * 100;
  const over = variance > 0;

  deltaEl.className = `metric-delta ${over ? "over" : "under"}`;
  arrowEl.textContent = over ? "▲" : "▼";
  amountEl.textContent = `${over ? "+" : "−"}${fmtMoney(Math.abs(variance))}`;
  pctEl.textContent = `(${over ? "+" : ""}${pct.toFixed(1)}%)`;
  subEl.textContent = `Variance vs. ${fmtMoney(monthlyBudget)} monthly budget`;
}

function renderTrendChart(trend, summary) {
  const canvas = document.getElementById("trendChart");
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const monthPoints = trend.filter((t) => new Date(t.date + "T00:00:00") >= monthStart);
  let running = 0;
  const cumulative = monthPoints.map((t) => { running += t.expense; return running; });
  const labels = monthPoints.map((t) => new Date(t.date + "T00:00:00").toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit" }));

  const monthlyBudget = summary.monthly_budget || 0;
  // With only one day of data there's no second point to draw a line
  // segment through, so a point marker is the only way anything shows up.
  const sparsePointRadius = monthPoints.length > 1 ? 0 : 4;
  const datasets = [
    {
      label: "Cumulative spend",
      data: cumulative,
      borderColor: "#c9a24b",
      backgroundColor: "rgba(201,162,75,0.08)",
      fill: true,
      tension: 0.3,
      pointRadius: sparsePointRadius,
      pointHoverRadius: 4,
      pointBackgroundColor: "#c9a24b",
      borderWidth: 2.5,
    },
  ];
  if (monthlyBudget > 0) {
    datasets.push({
      label: "Budget target",
      data: monthPoints.map(() => monthlyBudget),
      borderColor: "#e2543f",
      borderDash: [6, 5],
      pointRadius: sparsePointRadius,
      pointHoverRadius: 4,
      pointBackgroundColor: "#e2543f",
      borderWidth: 1.5,
      fill: false,
    });
  }

  if (trendChart) trendChart.destroy();
  trendChart = new Chart(canvas, {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { labels: { color: "#8c95a3", font: { family: "Inter", size: 11.5 } } },
        tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${fmtMoney(ctx.parsed.y)}` } },
      },
      scales: {
        x: { ticks: { color: "#5b6472", maxTicksLimit: 8, font: { size: 10.5 } }, grid: { color: "#2b323d" } },
        y: { ticks: { color: "#5b6472", font: { size: 10.5 } }, grid: { color: "#2b323d" } },
      },
    },
  });
}

function renderAlerts(alerts) {
  const list = document.getElementById("alertsList");
  const count = document.getElementById("alertCount");
  list.innerHTML = "";
  count.textContent = alerts && alerts.length ? `${alerts.length} active` : "";
  if (!alerts || alerts.length === 0) {
    list.innerHTML = `<div class="empty-state empty-state--ok">All indicators nominal. No alerts right now.</div>`;
    return;
  }
  alerts.forEach((a) => {
    const div = document.createElement("div");
    div.className = `alert alert-${a.severity}`;
    div.innerHTML = `<span class="alert-tag">${escapeHtml(a.category)}</span><span>${escapeHtml(a.message)}</span>`;
    list.appendChild(div);
  });
}

function renderLedger() {
  const list = document.getElementById("ledgerList");
  const filtered = allTxns.filter((t) => {
    if (ledgerFilter !== "all" && t.type !== ledgerFilter) return false;
    if (ledgerSearchTerm) {
      const haystack = `${t.description || ""} ${t.category || ""}`.toLowerCase();
      if (!haystack.includes(ledgerSearchTerm)) return false;
    }
    return true;
  });

  document.getElementById("txnCount").textContent = allTxns.length ? `${allTxns.length} entries` : "";
  list.innerHTML = "";

  if (!allTxns.length) {
    list.innerHTML = `<div class="empty-state">No transactions yet. Log your first one above.</div>`;
    return;
  }
  if (!filtered.length) {
    list.innerHTML = `<div class="empty-state">No entries match this filter.</div>`;
    return;
  }

  filtered.forEach((t) => {
    const row = document.createElement("div");
    row.className = "ledger-row";
    const dateFmt = new Date(t.date + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short" });
    row.innerHTML = `
      <div class="ledger-date">${dateFmt}</div>
      <div class="ledger-desc">
        <span class="ledger-desc-main">${escapeHtml(t.description || t.category)}</span>
        <span class="ledger-cat">${escapeHtml(t.category)}</span>
      </div>
      <div class="ledger-amount ${t.type}">${t.type === "income" ? "+" : "−"}${fmtMoney(t.amount)}</div>
      <button class="ledger-delete" title="Delete" data-id="${t.id}">&times;</button>
    `;
    row.querySelector(".ledger-delete").addEventListener("click", () => deleteTransaction(t.id));
    list.appendChild(row);
  });
}

function renderCategoryBudgetList(budgets, breakdown) {
  const el = document.getElementById("categoryBudgetList");
  el.innerHTML = "";
  const entries = Object.entries(budgets || {});
  if (!entries.length) {
    el.innerHTML = `<div class="empty-state">No category limits set yet.</div>`;
    return;
  }
  entries.forEach(([cat, limit]) => {
    const spent = (breakdown && breakdown[cat]) || 0;
    const pct = limit > 0 ? Math.min(1, spent / limit) : 0;
    const over = limit > 0 && spent > limit;
    const near = !over && pct >= 0.8;
    const row = document.createElement("div");
    row.className = "cb-row";
    row.innerHTML = `
      <div class="cb-row-head"><span>${escapeHtml(cat)}</span><span>${fmtMoney(spent)} / ${fmtMoney(limit)}</span></div>
      <div class="cb-bar"><div class="cb-bar-fill ${over ? "over" : near ? "near" : ""}" style="width:${pct * 100}%"></div></div>
    `;
    el.appendChild(row);
  });
}

// ---------- actions ----------

function setSelectedType(type) {
  selectedType = type;
  document.querySelectorAll("#typeSegment .segmented-btn").forEach((btn) => {
    const active = btn.dataset.type === type;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  });
}

function setLedgerFilter(filter) {
  ledgerFilter = filter;
  document.querySelectorAll("#filterSegment .segmented-btn").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.filter === filter);
  });
  renderLedger();
}

async function onAddTransaction(e) {
  e.preventDefault();
  const amount = parseFloat(document.getElementById("txnAmount").value);
  const dateVal = document.getElementById("txnDate").value;
  const description = document.getElementById("txnDesc").value.trim();
  const category = document.getElementById("txnCategory").value || null;

  if (!amount || amount <= 0) return;

  try {
    await fetchJSON(`${API}/transactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: selectedType, amount, date: dateVal || null, description, category }),
    });
  } catch (err) {
    toast(err.message || "Couldn't log that transaction", true);
    return;
  }

  document.getElementById("txnAmount").value = "";
  document.getElementById("txnDesc").value = "";
  document.getElementById("txnCategory").value = "";
  document.getElementById("txnDate").valueAsDate = new Date();

  toast(`Logged ${selectedType === "income" ? "income" : "expense"} of ${fmtMoney(amount)}`);
  refreshAll();
}

async function deleteTransaction(id) {
  try {
    await fetchJSON(`${API}/transactions/${id}`, { method: "DELETE" });
  } catch (err) {
    toast(err.message || "Couldn't delete that entry", true);
    return;
  }
  toast("Entry deleted");
  refreshAll();
}

async function onSaveSettings(e) {
  e.preventDefault();
  const starting_balance = parseFloat(document.getElementById("setBalance").value) || 0;
  const monthly_budget = parseFloat(document.getElementById("setBudget").value) || 0;
  const currency = document.getElementById("setCurrency").value || "₹";

  try {
    await fetchJSON(`${API}/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ starting_balance, monthly_budget, currency }),
    });
  } catch (err) {
    toast(err.message || "Couldn't save settings", true);
    return;
  }

  toast("Settings saved");
  closeSettingsDrawer();
  refreshAll();
}

async function onSaveCategoryBudget(e) {
  e.preventDefault();
  const category = document.getElementById("cbCategory").value;
  const monthly_limit = parseFloat(document.getElementById("cbLimit").value);
  if (!category || !monthly_limit) return;

  try {
    await fetchJSON(`${API}/category-budgets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category, monthly_limit }),
    });
  } catch (err) {
    toast(err.message || "Couldn't save that limit", true);
    return;
  }

  document.getElementById("cbLimit").value = "";
  toast(`Limit set for ${category}`);
  const [budgets, dashboard] = await Promise.all([
    fetchJSON(`${API}/category-budgets`),
    fetchJSON(`${API}/dashboard`),
  ]);
  renderCategoryBudgetList(budgets, dashboard.summary.category_breakdown);
}

function openSettingsDrawer() {
  document.getElementById("settingsDrawer").classList.add("open");
  document.getElementById("drawerBackdrop").classList.add("open");
}
function closeSettingsDrawer() {
  document.getElementById("settingsDrawer").classList.remove("open");
  document.getElementById("drawerBackdrop").classList.remove("open");
}

function toast(message, isError) {
  const root = document.getElementById("toastRoot");
  const el = document.createElement("div");
  el.className = `toast${isError ? " toast-error" : ""}`;
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transition = "opacity 0.2s";
    setTimeout(() => el.remove(), 220);
  }, 2600);
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}
