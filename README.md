# expense-tracker

# Ledger — AI Expense Tracker with Broke Date Prediction

A working web app: FastAPI backend + SQLite database + an HTML/CSS/JS dashboard.
No build step, no external accounts needed — runs entirely on your machine.

## What's implemented

| Feature | Status | How |
|---|---|---|
| **Sign up / log in / log out** | ✅ Full | `/api/auth/*`, session tokens (see below) |
| **Password hashing** | ✅ Full | PBKDF2-HMAC-SHA256, 600k iterations, random per-user salt — stdlib `hashlib`, no extra dependency |
| **Each user has their own expenses** | ✅ Full | every table (`transactions`, `settings`, `category_budgets`) is keyed by `user_id`; every query filters by the logged-in user |
| **Edit a transaction** | ✅ Full | pencil icon on each ledger row → modal → `PUT /api/transactions/{id}` |
| **Date filtering** | ✅ Full | Today / This Week / This Month / Custom Range, drives the ledger, the category chart, and CSV export |
| **Broke Date section** | ✅ Full | Current Balance, Average Daily Spending, Estimated Remaining, Predicted Broke Date, Risk (Low/Medium/High) + plain-English explanation |
| **Spending-limit warning** | ✅ Full | banner appears once you've used ≥80% of your monthly budget ("⚠️ You have used 85% of your monthly budget") |
| **Category analysis + chart** | ✅ Full | doughnut chart over Food/Shopping/Transport/Bills/Entertainment/Health/etc., follows the ledger's date filter |
| **Export CSV** | ✅ Full | "Download CSV" button, respects the active date filter |
| Auto-categorization | ✅ Full (rule-based) | keyword match in `categorize.py` |
| Unusual spending detection / budget alerts | ✅ Full | `alerts.py` |
| "Zero manual entry" via phone notifications | ⚠️ Not possible here | needs a native Android notification-listener service; `categorize.py` is ready to receive that text once you wire it up |
| "AI Roast Mode" over WhatsApp | ⚠️ Simulated in-app | roast messages are generated and shown as in-app alerts; real delivery needs WhatsApp Business API/Twilio |

## Authentication — how it works

- **Passwords** are never stored in plaintext. Each password is hashed with
  PBKDF2-HMAC-SHA256 (600,000 iterations, a random 16-byte salt per user).
  This is stdlib-only (`hashlib`), so there's nothing extra to `pip install`.
- **Sessions** are opaque random tokens (`secrets.token_urlsafe`). The raw
  token goes to the browser and is stored in `localStorage`; the server only
  ever stores its SHA-256 hash in the `sessions` table, alongside an expiry
  (7 days). Every API request sends `Authorization: Bearer <token>`.
  Logging out deletes that session row, so the token stops working
  immediately — something a stateless JWT can't do without extra
  infrastructure (a revocation list).
- If you had an old pre-auth database file, it's auto-detected on startup
  and backed up as `expense_tracker.pre-auth-backup.<timestamp>.db` rather
  than silently wiped, since the schema changed to add `user_id` everywhere.

## Broke Date — how it's calculated

**Baseline** (always available once you have any spending history):
```
avg_daily_net_spending = (total expenses − total income) / days observed
days_remaining = current_balance / avg_daily_net_spending
broke_date = today + days_remaining
```

**Trend model** (kicks in once you have 10+ days of distinct transaction dates):
Fits a linear regression (scikit-learn) of your running balance over time.
The slope becomes your modeled daily burn rate, and the date the line crosses
zero is the predicted Broke Date. The dashboard shows the trend model once
it's available, with the baseline kept alongside for comparison
(`GET /api/broke-date` returns both).

**Risk level**: High if you have ≤7 days of runway, Medium if ≤21 days, Low
otherwise (or if income already covers spending). Shown as a badge next to
the Broke Date, plus a one-line plain-English explanation, e.g. *"At your
current spending rate of about ₹420/day, your balance may reach ₹0 around
September 28, 2026."*

If your average net spending is zero or negative, there's no Broke Date —
the app tells you you're in the clear instead of showing a stale projection.

## Running it

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload
```

Open **http://localhost:8000** — the FastAPI app serves the frontend directly,
so there's nothing else to start.

First time: sign up with a username and password. Then open **Settings**
(top right) and enter your current balance and monthly budget. Add a few
transactions — the Broke Date card and budget warning update instantly.

## Project structure

```
expense-tracker/
  backend/
    main.py             FastAPI app, all routes, serves the frontend
    auth.py              Password hashing + session token handling
    database.py          SQLite connection + multi-user schema (+ migration guard)
    schemas.py            Pydantic request/response models
    categorize.py        Rule-based category matcher
    predictor.py          Baseline + regression Broke Date models, risk level
    alerts.py              Budget alerts, budget-usage %, Roast Mode messages
    requirements.txt
  frontend/
    index.html            Auth screen + dashboard + edit modal
    style.css
    app.js
    vendor/chart.umd.js    (Chart.js, bundled locally — no CDN dependency)
  README.md
```

## API reference (new/changed endpoints)

| Method | Path | Notes |
|---|---|---|
| POST | `/api/auth/signup` | `{username, password}` → `{token, user}` |
| POST | `/api/auth/login` | `{username, password}` → `{token, user}` |
| POST | `/api/auth/logout` | revokes the current token |
| GET | `/api/auth/me` | returns the logged-in user |
| GET/POST | `/api/transactions` | now scoped to the logged-in user; accepts `?range=today\|week\|month\|custom\|all&start=&end=` |
| **PUT** | `/api/transactions/{id}` | **new** — edit any field of a transaction you own |
| GET | `/api/summary`, `/api/dashboard` | accept the same `range` params; `summary.budget_usage` powers the warning banner |
| GET | `/api/export/csv` | **new** — downloads a CSV for the active date range |

All data endpoints (transactions, settings, category-budgets, summary,
broke-date, alerts, dashboard, export) require `Authorization: Bearer <token>`
and only ever touch the calling user's rows.

## Extending it

- **Smarter categorization**: `categorize.py` has a stub for dropping in a
  real LLM call for merchant strings the keyword list doesn't recognize.
- **Real WhatsApp Roast Mode**: cron a daily job that calls `GET /api/alerts`
  and forwards `type: "roast"` messages to the WhatsApp Business API.
- **Bank/UPI import**: add an endpoint that accepts a CSV or bank statement
  export and bulk-inserts via the same `/api/transactions` logic.
- **Switch database**: swap `database.py` for SQLAlchemy against Postgres if
  you outgrow SQLite — all queries are isolated there, so the rest of the app
  doesn't need to change.
- **Stronger sessions**: if you deploy this beyond localhost, consider adding
  HTTPS, a `Secure`/`HttpOnly` cookie instead of `localStorage`, and CSRF
  protection.
