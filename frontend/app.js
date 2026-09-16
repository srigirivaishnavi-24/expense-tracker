// Figure out where the backend actually lives, instead of hardcoding it.
//
// - Deployed (or run via `uvicorn` and opened at the backend's own root,
//   e.g. http://127.0.0.1:8000/): the backend serves this frontend itself,
//   so the API is on the SAME origin as the page → use a relative path.
//   This is what makes it work after deployment, on whatever domain it
//   ends up on, with no code changes needed.
// - Local dev via a separate static server (e.g. VS Code "Live Server" on
//   port 5500) while the backend runs on port 8000: the page's origin is
//   NOT the backend's origin, so we point explicitly at localhost:8000.
const API = (() => {
  const { protocol, hostname, port, origin } = window.location;
  const isLocalHost = hostname === "127.0.0.1" || hostname === "localhost";
  if (isLocalHost && port !== "8000") {
    return `${protocol}//${hostname}:8000/api`;
  }
  return `${origin}/api`;
})();

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
let editSelectedType = "expense";
let ledgerFilter = "all";
let ledgerSearchTerm = "";
let allTxns = [];
let authToken = null;
let currentUser = null;

// date-range filter state for the ledger / dashboard
let dateRange = "month";
let customStart = "";
let customEnd = "";

// ---------- auth bootstrap ----------

document.addEventListener("DOMContentLoaded", () => {
  populateCategorySelects();
  buildGaugeTicks();
  document.getElementById("txnDate").valueAsDate = new Date();

  wireAuthScreen();
  wireAppScreen();

  authToken = localStorage.getItem("ledger_token");
  const storedUser = localStorage.getItem("ledger_user");
  currentUser = storedUser ? JSON.parse(storedUser) : null;

  if (authToken && currentUser) {
    showApp();
  } else {
    showAuthScreen();
  }
});

function showAuthScreen() {
  document.getElementById("authScreen").style.display = "flex";
  document.getElementById("appRoot").style.display = "none";
}

function showApp() {
  document.getElementById("authScreen").style.display = "none";
  document.getElementById("appRoot").style.display = "block";
  document.getElementById("userChip").textContent = currentUser ? currentUser.username : "";
  refreshAll();
}

function wireAuthScreen() {
  document.querySelectorAll("#authTabs .segmented-btn").forEach((btn) => {
    btn.addEventListener("click", () => setAuthTab(btn.dataset.tab));
  });

  document.getElementById("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const identifier = document.getElementById("loginIdentifier").value.trim();
    const password = document.getElementById("loginPassword").value;
    const errEl = document.getElementById("loginError");
    errEl.textContent = "";
    try {
      const data = await fetchJSON(`${API}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier, password }),
      }, /*skipAuth*/ true);
      setSession(data.token, data.user);
      showApp();
    } catch (err) {
      errEl.textContent = err.message || "Couldn't log in";
    }
  });

  document.getElementById("signupForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = document.getElementById("signupUsername").value.trim();
    const email = document.getElementById("signupEmail").value.trim();
    const password = document.getElementById("signupPassword").value;
    const errEl = document.getElementById("signupError");
    errEl.textContent = "";
    try {
      const data = await fetchJSON(`${API}/auth/signup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, email, password }),
      }, /*skipAuth*/ true);
      setSession(data.token, data.user);
      showApp();
    } catch (err) {
      errEl.textContent = err.message || "Couldn't create that account";
    }
  });
}

function setAuthTab(tab) {
  document.querySelectorAll("#authTabs .segmented-btn").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.tab === tab);
  });
  document.getElementById("loginForm").style.display = tab === "login" ? "flex" : "none";
  document.getElementById("signupForm").style.display = tab === "signup" ? "flex" : "none";
  document.getElementById("loginError").textContent = "";
  document.getElementById("signupError").textContent = "";
}

function setSession(token, user) {
  authToken = token;
  currentUser = user;
  localStorage.setItem("ledger_token", token);
  localStorage.setItem("ledger_user", JSON.stringify(user));
}

function clearSession() {
  authToken = null;
  currentUser = null;
  localStorage.removeItem("ledger_token");
  localStorage.removeItem("ledger_user");
}

async function logout() {
  try {
    await fetchJSON(`${API}/auth/logout`, { method: "POST" });
  } catch (e) { /* token may already be invalid — fine, we're clearing it either way */ }
  clearSession();
  document.getElementById("loginForm").reset();
  document.getElementById("signupForm").reset();
  showAuthScreen();
}

// ---------- app screen wiring ----------

function wireAppScreen() {
  document.getElementById("txnForm").addEventListener("submit", onAddTransaction);
  document.getElementById("settingsForm").addEventListener("submit", onSaveSettings);
  document.getElementById("categoryBudgetForm").addEventListener("submit", onSaveCategoryBudget);
  document.getElementById("openSettings").addEventListener("click", openSettingsDrawer);
  document.getElementById("closeSettings").addEventListener("click", closeSettingsDrawer);
  document.getElementById("drawerBackdrop").addEventListener("click", closeSettingsDrawer);
  document.getElementById("logoutBtn").addEventListener("click", logout);

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

  document.querySelectorAll("#dateRangeSegment .segmented-btn").forEach((btn) => {
    btn.addEventListener("click", () => setDateRange(btn.dataset.range));
  });
  document.getElementById("applyCustomRange").addEventListener("click", () => {
    customStart = document.getElementById("rangeStart").value;
    customEnd = document.getElementById("rangeEnd").value;
    if (!customStart || !customEnd) {
      toast("Pick both a start and end date", true);
      return;
    }
    refreshAll();
  });

  // edit modal
  document.getElementById("closeEdit").addEventListener("click", closeEditModal);
  document.getElementById("editBackdrop").addEventListener("click", (e) => {
    if (e.target.id === "editBackdrop") closeEditModal();
  });
  document.getElementById("editForm").addEventListener("submit", onSaveEdit);
  document.querySelectorAll("#editTypeSegment .segmented-btn").forEach((btn) => {
    btn.addEventListener("click", () => setEditType(btn.dataset.type));
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closeSettingsDrawer(); closeEditModal(); }
  });
}

function populateCategorySelects() {
  const txnSel = document.getElementById("txnCategory");
  const cbSel = document.getElementById("cbCategory");
  const editSel = document.getElementById("editCategory");
  CATEGORIES.forEach((c) => {
    const o1 = document.createElement("option");
    o1.value = c; o1.textContent = c;
    txnSel.appendChild(o1);
    const o2 = document.createElement("option");
    o2.value = c; o2.textContent = c;
    cbSel.appendChild(o2);
    const o3 = document.createElement("option");
    o3.value = c; o3.textContent = c;
    editSel.appendChild(o3);
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

// ---------- date-range query helper ----------

function rangeQuery() {
  const params = new URLSearchParams();
  params.set("range", dateRange);
  if (dateRange === "custom" && customStart && customEnd) {
    params.set("start", customStart);
    params.set("end", customEnd);
  }
  return params.toString();
}

function setDateRange(range) {
  dateRange = range;
  document.querySelectorAll("#dateRangeSegment .segmented-btn").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.range === range);
  });
  document.getElementById("customRangeRow").style.display = range === "custom" ? "flex" : "none";
  if (range !== "custom") {
    refreshAll();
  }
}

// ---------- data refresh ----------

async function refreshAll() {
  let dashboard, txns, catBudgets, settings;
  const qs = rangeQuery();
  try {
    [dashboard, txns, catBudgets, settings] = await Promise.all([
      fetchJSON(`${API}/dashboard?${qs}`),
      fetchJSON(`${API}/transactions?${qs}`),
      fetchJSON(`${API}/category-budgets`),
      fetchJSON(`${API}/settings`),
    ]);
  } catch (err) {
    if (err.status !== 401) toast(err.message || "Couldn't reach the server", true);
    return;
  }

  currentCurrency = dashboard.summary.currency || "₹";
  allTxns = txns;

  renderStats(dashboard.summary);
  renderBrokeDate(dashboard.broke_date);
  renderBudgetBanner(dashboard.summary.budget_usage);
  safely(() => renderCategoryChart(dashboard.summary.category_breakdown, dashboard.summary.category_breakdown_range));
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

async function fetchJSON(url, options, skipAuth) {
  options = options || {};
  if (!skipAuth && authToken) {
    options.headers = Object.assign({}, options.headers, { Authorization: `Bearer ${authToken}` });
  }
  const res = await fetch(url, options);
  if (res.status === 401 && !skipAuth) {
    clearSession();
    showAuthScreen();
    const err = new Error("Your session expired — please log in again");
    err.status = 401;
    throw err;
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    const e = new Error(formatApiError(err.detail));
    e.status = res.status;
    throw e;
  }
  return res.json();
}

function formatApiError(detail) {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail) && detail[0] && detail[0].msg) return detail[0].msg;
  return "Something went wrong";
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

function renderBudgetBanner(usage) {
  const banner = document.getElementById("budgetBanner");
  if (!usage || usage.pct_used === null || usage.pct_used === undefined) {
    banner.style.display = "none";
    return;
  }
  if (usage.pct_used < 80) {
    banner.style.display = "none";
    return;
  }
  const over = usage.pct_used >= 100;
  banner.style.display = "flex";
  banner.className = `budget-banner ${over ? "budget-banner--over" : "budget-banner--warning"}`;
  banner.innerHTML = `
    <span class="budget-banner-icon">⚠️</span>
    <span>${over ? "You've gone over" : "You have used"} <strong>${usage.pct_used}%</strong> of your monthly budget
    (${fmtMoney(usage.spent)} of ${fmtMoney(usage.monthly_budget)}).</span>
  `;
}

function renderBrokeDate(prediction) {
  const primary = prediction.primary || {};
  const big = document.getElementById("brokeDateBig");
  const sub = document.getElementById("brokeDateSub");
  const meta = document.getElementById("heroMeta");
  const facts = document.getElementById("heroFacts");
  const explanation = document.getElementById("heroExplanation");
  const riskBadge = document.getElementById("riskBadge");
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
  explanation.textContent = prediction.explanation || "";

  // Risk badge
  const risk = prediction.risk || {};
  if (risk.label) {
    riskBadge.style.display = "inline-flex";
    riskBadge.className = `risk-badge risk-${risk.level}`;
    riskBadge.textContent = `${risk.emoji || ""} Risk: ${risk.label}`.trim();
  } else {
    riskBadge.style.display = "none";
  }

  // Key facts row: Current Balance / Average Daily Spending / Estimated Remaining
  const factItems = [
    { label: "Current balance", value: fmtMoney(prediction.current_balance) },
    { label: "Avg. daily spending", value: fmtMoney(prediction.avg_daily_spending) },
  ];
  if (primary.days_remaining !== null && primary.days_remaining !== undefined) {
    factItems.push({ label: "Estimated remaining", value: `${Math.round(primary.days_remaining)} days` });
  }
  facts.innerHTML = factItems.map(
    (f) => `<div class="hero-fact"><span class="hero-fact-label">${f.label}</span><span class="hero-fact-value">${f.value}</span></div>`
  ).join("");

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

function renderCategoryChart(breakdown, rangeLabel) {
  const entries = Object.entries(breakdown || {}).sort((a, b) => b[1] - a[1]);
  const emptyEl = document.getElementById("categoryEmpty");
  const canvas = document.getElementById("categoryChart");
  const labelEl = document.getElementById("categoryRangeLabel");
  if (labelEl) {
    const labels = { today: "Today", week: "This week", month: "This month", custom: "Custom range", all: "All time" };
    labelEl.textContent = labels[rangeLabel] || "This month";
  }

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
    type: "doughnut",
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
      cutout: "58%",
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
  const datasets = [
    {
      label: "Cumulative spend",
      data: cumulative,
      borderColor: "#c9a24b",
      backgroundColor: "rgba(201,162,75,0.08)",
      fill: true,
      tension: 0.3,
      pointRadius: 0,
      borderWidth: 2.5,
    },
  ];
  if (monthlyBudget > 0) {
    datasets.push({
      label: "Budget target",
      data: monthPoints.map(() => monthlyBudget),
      borderColor: "#e2543f",
      borderDash: [6, 5],
      pointRadius: 0,
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
    list.innerHTML = `<div class="empty-state">No transactions in this period. Log one above or change the date filter.</div>`;
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
      <div class="ledger-actions">
        <button class="ledger-edit" title="Edit" data-id="${t.id}">✎</button>
        <button class="ledger-delete" title="Delete" data-id="${t.id}">&times;</button>
      </div>
    `;
    row.querySelector(".ledger-delete").addEventListener("click", () => deleteTransaction(t.id));
    row.querySelector(".ledger-edit").addEventListener("click", () => openEditModal(t));
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

function setEditType(type) {
  editSelectedType = type;
  document.querySelectorAll("#editTypeSegment .segmented-btn").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.type === type);
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

function openEditModal(t) {
  document.getElementById("editId").value = t.id;
  document.getElementById("editAmount").value = t.amount;
  document.getElementById("editDate").value = t.date;
  document.getElementById("editDesc").value = t.description || "";
  document.getElementById("editCategory").value = t.category;
  setEditType(t.type);
  document.getElementById("editBackdrop").style.display = "flex";
}

function closeEditModal() {
  document.getElementById("editBackdrop").style.display = "none";
}

async function onSaveEdit(e) {
  e.preventDefault();
  const id = document.getElementById("editId").value;
  const amount = parseFloat(document.getElementById("editAmount").value);
  const dateVal = document.getElementById("editDate").value;
  const description = document.getElementById("editDesc").value.trim();
  const category = document.getElementById("editCategory").value;

  try {
    await fetchJSON(`${API}/transactions/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: editSelectedType, amount, date: dateVal, description, category }),
    });
  } catch (err) {
    toast(err.message || "Couldn't save those changes", true);
    return;
  }

  toast("Transaction updated");
  closeEditModal();
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
    fetchJSON(`${API}/dashboard?${rangeQuery()}`),
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
