# expense-tracker
A simple expense tracker web application to manage, categorize and analyze expenses.

# Ledger — AI Expense Tracker with Broke Date Prediction

A working web app: FastAPI backend + SQLite database + an HTML/CSS/JS dashboard.
No build step, no external accounts needed — runs entirely on your machine.

## What's actually implemented

| Feature from the brief | Status | How |
|---|---|---|
| Log income/expenses with amount, date, description, category | ✅ Full | `/api/transactions` |
| Auto-categorization | ✅ Full (rule-based) | keyword match in `categorize.py`, ~13 categories |
| Daily/weekly/monthly spend patterns | ✅ Full | `/api/summary` |
| **Broke Date prediction** | ✅ Full, two models | baseline formula + linear-regression trend model, see below |
| Unusual spending detection | ✅ Full | frequency spikes per category per week |
| Budget alerts & recommendations | ✅ Full | overall + per-category monthly limits |
| Charts/dashboard | ✅ Full | Chart.js: category donut + 30-day income/spend trend |
| "Zero manual entry" via reading phone payment notifications | ⚠️ Not possible here | needs a native Android notification-listener service + device permissions. The categorizer this would feed into is already built (`categorize.py`) — wire a notification listener to POST its text to `/api/transactions` and it works today. |
| "AI Roast Mode" over WhatsApp | ⚠️ Simulated in-app | Roast messages are generated (`alerts.py`) and shown as in-app alerts. Real WhatsApp delivery needs the WhatsApp Business API or Twilio — see note in `alerts.py` for where to plug that in. |

The first two "not possible here" items need phone-OS-level access and a paid messaging API that a sandboxed build can't set up on your behalf — but every piece of *logic* they'd depend on (categorization, roast text generation) is already built and tested, so hooking up the delivery mechanism later is a small job.

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
zero is the predicted Broke Date. This reacts to whether your spending is
accelerating or easing, rather than a flat average, and reports an R² so you
can see how well the trend actually fits. The dashboard shows the trend
model once it's available, with the baseline kept alongside for comparison
(`GET /api/broke-date` returns both).

If your average net spending is zero or negative (income covers or exceeds
spending), there's no Broke Date — the app tells you you're in the clear
instead of showing a stale projection.

## Running it

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload
```

Open **http://localhost:8000** — the FastAPI app serves the frontend directly,
so there's nothing else to start.

First time: click **Balance & budget** (top right) and enter your current
balance. Then add a few transactions — the Broke Date card updates instantly.

## Project structure

```
expense-tracker/
  backend/
    main.py          FastAPI app, all routes, serves the frontend
    database.py       SQLite connection + schema
    schemas.py         Pydantic request/response models
    categorize.py     Rule-based category matcher
    predictor.py       Baseline + regression Broke Date models
    alerts.py           Budget alerts + Roast Mode message generator
    requirements.txt
  frontend/
    index.html
    style.css
    app.js
    vendor/chart.umd.js   (Chart.js, bundled locally — no CDN dependency)
  README.md
```

## Extending it

- **Smarter categorization**: `categorize.py` has a stub
  (`categorize_with_llm_stub`) where you can drop in a real LLM call for
  merchant strings the keyword list doesn't recognize.
- **Real WhatsApp Roast Mode**: cron a daily job that calls `GET /api/alerts`
  and forwards `type: "roast"` messages to the WhatsApp Business API.
- **Bank/UPI import**: add an endpoint that accepts a CSV or a bank
  statement export and bulk-inserts via the same `/api/transactions` logic.
- **Switch database**: swap `database.py` for `psycopg2`/SQLAlchemy against
  Postgres if you outgrow SQLite — the rest of the app doesn't need to change
  since all queries are isolated there.
