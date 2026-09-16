from datetime import date, datetime, timedelta
from collections import defaultdict
from pathlib import Path
from typing import Optional, Literal

from fastapi import FastAPI, HTTPException, Depends, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from database import init_db, db_cursor, ensure_user_settings
from schemas import (
    TransactionIn, TransactionUpdate, SettingsIn, CategoryBudgetIn, CategorizeRequest,
    SignupIn, LoginIn,
)
from categorize import categorize
from predictor import predict_broke_date
from alerts import build_alerts, budget_usage
from auth import (
    hash_password, verify_password, create_session, destroy_session,
    get_current_user, get_token_from_header,
)

app = FastAPI(title="AI Expense Tracker with Broke Date Prediction")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

init_db()

FRONTEND_DIR = Path(__file__).parent.parent / "frontend"


# ---------- date-range helper (shared by list/summary/export) ----------

def resolve_date_range(range_: Optional[str], start: Optional[str], end: Optional[str]):
    """
    Turns the `range` query param (today / week / month / custom) plus
    optional start/end into a concrete (start_date, end_date) pair, or
    (None, None) for "all time".
    """
    today = date.today()
    if range_ in (None, "", "all"):
        return None, None
    if range_ == "today":
        return today, today
    if range_ == "week":
        return today - timedelta(days=today.weekday()), today
    if range_ == "month":
        return today.replace(day=1), today
    if range_ == "custom":
        if not start or not end:
            raise HTTPException(status_code=400, detail="Custom range needs both start and end dates")
        try:
            return date.fromisoformat(start), date.fromisoformat(end)
        except ValueError:
            raise HTTPException(status_code=400, detail="Dates must be in YYYY-MM-DD format")
    raise HTTPException(status_code=400, detail=f"Unknown range '{range_}'")


# ---------- helpers (all scoped to the current user) ----------

def get_settings(user_id: int):
    with db_cursor() as cur:
        cur.execute("SELECT * FROM settings WHERE user_id = ?", (user_id,))
        row = cur.fetchone()
        if not row:
            ensure_user_settings(user_id)
            cur.execute("SELECT * FROM settings WHERE user_id = ?", (user_id,))
            row = cur.fetchone()
        return dict(row)


def get_all_transactions(user_id: int, start: date = None, end: date = None):
    with db_cursor() as cur:
        if start and end:
            cur.execute(
                "SELECT * FROM transactions WHERE user_id = ? AND date >= ? AND date <= ? ORDER BY date ASC, id ASC",
                (user_id, start.isoformat(), end.isoformat()),
            )
        else:
            cur.execute("SELECT * FROM transactions WHERE user_id = ? ORDER BY date ASC, id ASC", (user_id,))
        return [dict(r) for r in cur.fetchall()]


def get_category_budgets(user_id: int):
    with db_cursor() as cur:
        cur.execute("SELECT * FROM category_budgets WHERE user_id = ?", (user_id,))
        return {r["category"]: r["monthly_limit"] for r in cur.fetchall()}


def compute_current_balance(user_id: int):
    """Current balance always reflects ALL transactions, regardless of any UI date filter."""
    settings = get_settings(user_id)
    txns = get_all_transactions(user_id)
    balance = settings["starting_balance"]
    for t in txns:
        balance += t["amount"] if t["type"] == "income" else -t["amount"]
    return balance, settings, txns


# ---------- auth ----------

@app.post("/api/auth/signup")
def signup(payload: SignupIn):
    with db_cursor() as cur:
        cur.execute("SELECT 1 FROM users WHERE username = ?", (payload.username,))
        if cur.fetchone():
            raise HTTPException(status_code=409, detail="That username is already taken")
        cur.execute("SELECT 1 FROM users WHERE email = ?", (payload.email,))
        if cur.fetchone():
            raise HTTPException(status_code=409, detail="That email is already registered")

    password_hash, salt = hash_password(payload.password)
    with db_cursor(commit=True) as cur:
        cur.execute(
            "INSERT INTO users (username, email, password_hash, password_salt) VALUES (?, ?, ?, ?)",
            (payload.username, payload.email, password_hash, salt),
        )
        user_id = cur.lastrowid
    ensure_user_settings(user_id)

    token = create_session(user_id)
    return {"token": token, "user": {"id": user_id, "username": payload.username, "email": payload.email}}


@app.post("/api/auth/login")
def login(payload: LoginIn):
    identifier = payload.identifier.strip().lower()
    with db_cursor() as cur:
        cur.execute(
            "SELECT * FROM users WHERE lower(username) = ? OR lower(email) = ?",
            (identifier, identifier),
        )
        row = cur.fetchone()

    # Constant-shape error regardless of which part was wrong, so login
    # doesn't leak whether an account exists.
    if not row or not verify_password(payload.password, row["password_salt"], row["password_hash"]):
        raise HTTPException(status_code=401, detail="Incorrect email/username or password")

    token = create_session(row["id"])
    return {"token": token, "user": {"id": row["id"], "username": row["username"], "email": row["email"]}}


@app.post("/api/auth/logout")
def logout(token: str = Depends(get_token_from_header)):
    destroy_session(token)
    return {"logged_out": True}


@app.get("/api/auth/me")
def me(user=Depends(get_current_user)):
    return user


# ---------- transactions ----------

@app.post("/api/transactions")
def add_transaction(payload: TransactionIn, user=Depends(get_current_user)):
    tx_date = (payload.date or date.today()).isoformat()
    category = payload.category
    if not category:
        category = "Salary / Income" if payload.type == "income" else categorize(payload.description)

    with db_cursor(commit=True) as cur:
        cur.execute(
            "INSERT INTO transactions (user_id, amount, type, category, description, date) VALUES (?, ?, ?, ?, ?, ?)",
            (user["id"], payload.amount, payload.type, category, payload.description, tx_date),
        )
        new_id = cur.lastrowid
        cur.execute("SELECT * FROM transactions WHERE id = ? AND user_id = ?", (new_id, user["id"]))
        row = dict(cur.fetchone())
    return row


@app.get("/api/transactions")
def list_transactions(
    limit: int = 500,
    range: Optional[str] = Query(None, description="today | week | month | custom | all"),
    start: Optional[str] = None,
    end: Optional[str] = None,
    user=Depends(get_current_user),
):
    start_d, end_d = resolve_date_range(range, start, end)
    with db_cursor() as cur:
        if start_d and end_d:
            cur.execute(
                "SELECT * FROM transactions WHERE user_id = ? AND date >= ? AND date <= ? "
                "ORDER BY date DESC, id DESC LIMIT ?",
                (user["id"], start_d.isoformat(), end_d.isoformat(), limit),
            )
        else:
            cur.execute(
                "SELECT * FROM transactions WHERE user_id = ? ORDER BY date DESC, id DESC LIMIT ?",
                (user["id"], limit),
            )
        return [dict(r) for r in cur.fetchall()]


@app.put("/api/transactions/{tx_id}")
def update_transaction(tx_id: int, payload: TransactionUpdate, user=Depends(get_current_user)):
    with db_cursor() as cur:
        cur.execute("SELECT * FROM transactions WHERE id = ? AND user_id = ?", (tx_id, user["id"]))
        existing = cur.fetchone()
    if not existing:
        raise HTTPException(status_code=404, detail="Transaction not found")

    fields = payload.dict(exclude_unset=True)
    if "date" in fields and fields["date"] is not None:
        fields["date"] = fields["date"].isoformat()

    if not fields:
        return dict(existing)

    set_clause = ", ".join(f"{k} = ?" for k in fields)
    with db_cursor(commit=True) as cur:
        cur.execute(
            f"UPDATE transactions SET {set_clause} WHERE id = ? AND user_id = ?",
            (*fields.values(), tx_id, user["id"]),
        )
        cur.execute("SELECT * FROM transactions WHERE id = ?", (tx_id,))
        row = dict(cur.fetchone())
    return row


@app.delete("/api/transactions/{tx_id}")
def delete_transaction(tx_id: int, user=Depends(get_current_user)):
    with db_cursor(commit=True) as cur:
        cur.execute("SELECT id FROM transactions WHERE id = ? AND user_id = ?", (tx_id, user["id"]))
        if not cur.fetchone():
            raise HTTPException(status_code=404, detail="Transaction not found")
        cur.execute("DELETE FROM transactions WHERE id = ? AND user_id = ?", (tx_id, user["id"]))
    return {"deleted": tx_id}


@app.post("/api/categorize")
def categorize_endpoint(payload: CategorizeRequest, user=Depends(get_current_user)):
    return {"category": categorize(payload.description)}


# ---------- settings ----------

@app.get("/api/settings")
def read_settings(user=Depends(get_current_user)):
    return get_settings(user["id"])


@app.post("/api/settings")
def update_settings(payload: SettingsIn, user=Depends(get_current_user)):
    fields = {k: v for k, v in payload.dict().items() if v is not None}
    if not fields:
        return get_settings(user["id"])
    ensure_user_settings(user["id"])
    set_clause = ", ".join(f"{k} = ?" for k in fields)
    with db_cursor(commit=True) as cur:
        cur.execute(f"UPDATE settings SET {set_clause} WHERE user_id = ?", (*fields.values(), user["id"]))
    return get_settings(user["id"])


@app.get("/api/category-budgets")
def list_category_budgets(user=Depends(get_current_user)):
    return get_category_budgets(user["id"])


@app.post("/api/category-budgets")
def set_category_budget(payload: CategoryBudgetIn, user=Depends(get_current_user)):
    with db_cursor(commit=True) as cur:
        cur.execute(
            """
            INSERT INTO category_budgets (user_id, category, monthly_limit) VALUES (?, ?, ?)
            ON CONFLICT(user_id, category) DO UPDATE SET monthly_limit = excluded.monthly_limit
            """,
            (user["id"], payload.category, payload.monthly_limit),
        )
    return get_category_budgets(user["id"])


# ---------- analytics ----------

@app.get("/api/summary")
def summary(
    range: Optional[str] = Query(None, description="today | week | month | custom | all"),
    start: Optional[str] = None,
    end: Optional[str] = None,
    user=Depends(get_current_user),
):
    balance, settings, all_txns = compute_current_balance(user["id"])
    today = date.today()
    week_start = today - timedelta(days=today.weekday())
    month_start = today.replace(day=1)

    def total(txn_list, kind):
        return sum(t["amount"] for t in txn_list if t["type"] == kind)

    today_txns = [t for t in all_txns if t["date"] == today.isoformat()]
    week_txns = [t for t in all_txns if date.fromisoformat(t["date"]) >= week_start]
    month_txns = [t for t in all_txns if date.fromisoformat(t["date"]) >= month_start]

    # The "Where it's going" pie chart follows whatever date filter the
    # ledger is using (defaults to this month) rather than always this month.
    start_d, end_d = resolve_date_range(range or "month", start, end)
    filtered_txns = [
        t for t in all_txns
        if (not start_d or date.fromisoformat(t["date"]) >= start_d)
        and (not end_d or date.fromisoformat(t["date"]) <= end_d)
    ]

    category_breakdown = defaultdict(float)
    for t in filtered_txns:
        if t["type"] == "expense":
            category_breakdown[t["category"]] += t["amount"]

    # last 30 days daily net trend, for the chart
    daily_totals = defaultdict(lambda: {"income": 0.0, "expense": 0.0})
    cutoff = today - timedelta(days=30)
    for t in all_txns:
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
        "category_breakdown_range": range or "month",
        "daily_trend": trend,
        "transaction_count": len(all_txns),
        "budget_usage": budget_usage(all_txns, settings["monthly_budget"]),
    }


@app.get("/api/broke-date")
def broke_date(user=Depends(get_current_user)):
    balance, settings, txns = compute_current_balance(user["id"])
    return predict_broke_date(txns, balance, settings["starting_balance"], settings["currency"])


@app.get("/api/alerts")
def alerts(user=Depends(get_current_user)):
    balance, settings, txns = compute_current_balance(user["id"])
    prediction = predict_broke_date(txns, balance, settings["starting_balance"], settings["currency"])
    category_budgets = get_category_budgets(user["id"])
    result = build_alerts(
        txns, category_budgets, settings["monthly_budget"], balance, prediction, settings["currency"]
    )
    return result


@app.get("/api/dashboard")
def dashboard(
    range: Optional[str] = Query(None),
    start: Optional[str] = None,
    end: Optional[str] = None,
    user=Depends(get_current_user),
):
    """Single call the frontend uses to refresh everything at once."""
    return {
        "summary": summary(range=range, start=start, end=end, user=user),
        "broke_date": broke_date(user=user),
        "alerts": alerts(user=user),
    }


# ---------- static frontend ----------

app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")


@app.get("/")
def serve_index():
    return FileResponse(FRONTEND_DIR / "index.html")
