from datetime import date, timedelta
from collections import defaultdict
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from database import init_db, db_cursor
from schemas import TransactionIn, SettingsIn, CategoryBudgetIn, CategorizeRequest
from categorize import categorize
from predictor import predict_broke_date
from alerts import build_alerts

app = FastAPI(title="AI Expense Tracker with Broke Date Prediction")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

init_db()

FRONTEND_DIR = Path(__file__).parent.parent / "frontend"


# ---------- helpers ----------

def get_settings():
    with db_cursor() as cur:
        cur.execute("SELECT * FROM settings WHERE id = 1")
        return dict(cur.fetchone())


def get_all_transactions():
    with db_cursor() as cur:
        cur.execute("SELECT * FROM transactions ORDER BY date ASC, id ASC")
        return [dict(r) for r in cur.fetchall()]


def get_category_budgets():
    with db_cursor() as cur:
        cur.execute("SELECT * FROM category_budgets")
        return {r["category"]: r["monthly_limit"] for r in cur.fetchall()}


def compute_current_balance():
    settings = get_settings()
    txns = get_all_transactions()
    balance = settings["starting_balance"]
    for t in txns:
        balance += t["amount"] if t["type"] == "income" else -t["amount"]
    return balance, settings, txns


# ---------- transactions ----------

@app.post("/api/transactions")
def add_transaction(payload: TransactionIn):
    tx_date = (payload.date or date.today()).isoformat()
    category = payload.category
    if not category:
        category = "Salary / Income" if payload.type == "income" else categorize(payload.description)

    with db_cursor(commit=True) as cur:
        cur.execute(
            "INSERT INTO transactions (amount, type, category, description, date) VALUES (?, ?, ?, ?, ?)",
            (payload.amount, payload.type, category, payload.description, tx_date),
        )
        new_id = cur.lastrowid
        cur.execute("SELECT * FROM transactions WHERE id = ?", (new_id,))
        row = dict(cur.fetchone())
    return row


@app.get("/api/transactions")
def list_transactions(limit: int = 200):
    with db_cursor() as cur:
        cur.execute("SELECT * FROM transactions ORDER BY date DESC, id DESC LIMIT ?", (limit,))
        return [dict(r) for r in cur.fetchall()]


@app.delete("/api/transactions/{tx_id}")
def delete_transaction(tx_id: int):
    with db_cursor(commit=True) as cur:
        cur.execute("SELECT id FROM transactions WHERE id = ?", (tx_id,))
        if not cur.fetchone():
            raise HTTPException(status_code=404, detail="Transaction not found")
        cur.execute("DELETE FROM transactions WHERE id = ?", (tx_id,))
    return {"deleted": tx_id}


@app.post("/api/categorize")
def categorize_endpoint(payload: CategorizeRequest):
    return {"category": categorize(payload.description)}


# ---------- settings ----------

@app.get("/api/settings")
def read_settings():
    return get_settings()


@app.post("/api/settings")
def update_settings(payload: SettingsIn):
    fields = {k: v for k, v in payload.dict().items() if v is not None}
    if not fields:
        return get_settings()
    set_clause = ", ".join(f"{k} = ?" for k in fields)
    with db_cursor(commit=True) as cur:
        cur.execute(f"UPDATE settings SET {set_clause} WHERE id = 1", tuple(fields.values()))
    return get_settings()


@app.get("/api/category-budgets")
def list_category_budgets():
    return get_category_budgets()


@app.post("/api/category-budgets")
def set_category_budget(payload: CategoryBudgetIn):
    with db_cursor(commit=True) as cur:
        cur.execute(
            """
            INSERT INTO category_budgets (category, monthly_limit) VALUES (?, ?)
            ON CONFLICT(category) DO UPDATE SET monthly_limit = excluded.monthly_limit
            """,
            (payload.category, payload.monthly_limit),
        )
    return get_category_budgets()


# ---------- analytics ----------

@app.get("/api/summary")
def summary():
    balance, settings, txns = compute_current_balance()
    today = date.today()
    week_ago = today - timedelta(days=7)
    month_start = today.replace(day=1)

    def total(txn_list, kind):
        return sum(t["amount"] for t in txn_list if t["type"] == kind)

    today_txns = [t for t in txns if t["date"] == today.isoformat()]
    week_txns = [t for t in txns if date.fromisoformat(t["date"]) >= week_ago]
    month_txns = [t for t in txns if date.fromisoformat(t["date"]) >= month_start]

    category_breakdown = defaultdict(float)
    for t in month_txns:
        if t["type"] == "expense":
            category_breakdown[t["category"]] += t["amount"]

    # last 30 days daily net trend, for the chart
    daily_totals = defaultdict(lambda: {"income": 0.0, "expense": 0.0})
    cutoff = today - timedelta(days=30)
    for t in txns:
        d = date.fromisoformat(t["date"])
        if d >= cutoff:
            daily_totals[t["date"]][t["type"]] += t["amount"]

    trend = []
    d = cutoff
    while d <= today:
        key = d.isoformat()
        entry = daily_totals.get(key, {"income": 0.0, "expense": 0.0})
        trend.append({"date": key, "income": entry["income"], "expense": entry["expense"]})
        d += timedelta(days=1)

    return {
        "currency": settings["currency"],
        "current_balance": round(balance, 2),
        "starting_balance": settings["starting_balance"],
        "monthly_budget": settings["monthly_budget"],
        "today_spent": round(total(today_txns, "expense"), 2),
        "week_spent": round(total(week_txns, "expense"), 2),
        "month_spent": round(total(month_txns, "expense"), 2),
        "month_income": round(total(month_txns, "income"), 2),
        "category_breakdown": dict(category_breakdown),
        "daily_trend": trend,
        "transaction_count": len(txns),
    }


@app.get("/api/broke-date")
def broke_date():
    balance, settings, txns = compute_current_balance()
    return predict_broke_date(txns, balance, settings["starting_balance"])


@app.get("/api/alerts")
def alerts():
    balance, settings, txns = compute_current_balance()
    prediction = predict_broke_date(txns, balance, settings["starting_balance"])
    category_budgets = get_category_budgets()
    result = build_alerts(
        txns, category_budgets, settings["monthly_budget"], balance, prediction, settings["currency"]
    )
    return result


@app.get("/api/dashboard")
def dashboard():
    """Single call the frontend uses to refresh everything at once."""
    return {
        "summary": summary(),
        "broke_date": broke_date(),
        "alerts": alerts(),
    }


# ---------- static frontend ----------

app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")


@app.get("/")
def serve_index():
    return FileResponse(FRONTEND_DIR / "index.html")
