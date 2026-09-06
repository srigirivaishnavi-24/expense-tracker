"""
Broke Date prediction.

Two methods, used depending on how much history is available:

1. Baseline (always available, needs >=1 day of data):
   days_remaining = current_balance / average_daily_net_spending
   broke_date = today + days_remaining

2. Trend model (needs >=10 days of distinct transaction dates):
   Fits a linear regression of running balance vs. day-number using
   scikit-learn. The slope is the modeled daily burn rate; the date where
   the fitted line crosses zero is the predicted Broke Date. This adapts
   to trends (e.g. spending accelerating or easing) rather than a flat
   average, and reports an R^2 confidence score.

Both return None for `broke_date` when net spending isn't positive
(balance is flat or growing) — i.e. there's no foreseeable broke date.
"""
from datetime import date, timedelta
from collections import defaultdict
import numpy as np


def _daily_net_series(transactions, starting_balance):
    """
    Build a running-balance-by-date series from a list of transaction rows
    (each a dict with 'date', 'type', 'amount'), starting from
    `starting_balance` at the earliest date.
    Returns list of (date_obj, running_balance) sorted ascending, one point
    per calendar day that had at least one transaction, plus today.
    """
    if not transactions:
        return []

    by_day = defaultdict(float)
    for t in transactions:
        signed = t["amount"] if t["type"] == "income" else -t["amount"]
        by_day[t["date"]] += signed

    days_sorted = sorted(by_day.keys())
    first_day = date.fromisoformat(days_sorted[0])
    today = date.today()

    running = starting_balance
    series = []
    d = first_day
    # Walk every calendar day from first transaction to today so gaps
    # (no-spend days) are represented too.
    while d <= today:
        key = d.isoformat()
        if key in by_day:
            running += by_day[key]
        series.append((d, running))
        d += timedelta(days=1)
    return series


def baseline_prediction(transactions, current_balance, window_days=30):
    """Simple average-burn-rate baseline."""
    if not transactions:
        return {
            "method": "baseline",
            "avg_daily_net_spending": 0.0,
            "days_remaining": None,
            "broke_date": None,
            "status": "insufficient_data",
        }

    cutoff = date.today() - timedelta(days=window_days)
    recent = [t for t in transactions if date.fromisoformat(t["date"]) >= cutoff]
    if not recent:
        recent = transactions

    dates = sorted(set(t["date"] for t in recent))
    span_days = max(1, (date.fromisoformat(dates[-1]) - date.fromisoformat(dates[0])).days + 1)

    total_expense = sum(t["amount"] for t in recent if t["type"] == "expense")
    total_income = sum(t["amount"] for t in recent if t["type"] == "income")
    avg_daily_net = (total_expense - total_income) / span_days

    if avg_daily_net <= 0:
        return {
            "method": "baseline",
            "avg_daily_net_spending": round(avg_daily_net, 2),
            "days_remaining": None,
            "broke_date": None,
            "status": "safe",
        }

    days_remaining = current_balance / avg_daily_net if avg_daily_net > 0 else None
    broke_date = (date.today() + timedelta(days=days_remaining)) if days_remaining and days_remaining > 0 else date.today()

    return {
        "method": "baseline",
        "avg_daily_net_spending": round(avg_daily_net, 2),
        "days_remaining": round(max(days_remaining, 0), 1) if days_remaining is not None else None,
        "broke_date": broke_date.isoformat() if days_remaining is not None else None,
        "status": "at_risk",
    }


def trend_prediction(transactions, starting_balance, min_points=10):
    """
    Linear regression of balance-over-time. Falls back to None if there
    isn't enough distinct-day history for a meaningful fit.
    """
    series = _daily_net_series(transactions, starting_balance)
    if len(series) < min_points:
        return None

    x = np.array([(d - series[0][0]).days for d, _ in series], dtype=float).reshape(-1, 1)
    y = np.array([bal for _, bal in series], dtype=float)

    try:
        from sklearn.linear_model import LinearRegression

        model = LinearRegression()
        model.fit(x, y)
        slope = float(model.coef_[0])          # balance change per day
        intercept = float(model.intercept_)
        r2 = float(model.score(x, y))
    except Exception:
        # Fallback to numpy polyfit if sklearn isn't available for some reason
        slope, intercept = np.polyfit(x.flatten(), y, 1)
        slope, intercept = float(slope), float(intercept)
        y_pred = slope * x.flatten() + intercept
        ss_res = float(np.sum((y - y_pred) ** 2))
        ss_tot = float(np.sum((y - np.mean(y)) ** 2)) or 1.0
        r2 = 1 - ss_res / ss_tot

    if slope >= 0:
        return {
            "method": "trend",
            "daily_trend": round(slope, 2),
            "confidence_r2": round(max(r2, 0), 3),
            "days_remaining": None,
            "broke_date": None,
            "status": "safe",
        }

    # Solve slope * x + intercept = 0  ->  x = -intercept / slope
    x_zero = -intercept / slope
    today_x = (date.today() - series[0][0]).days
    days_remaining = x_zero - today_x

    if days_remaining < 0:
        # Model says balance should already be at/below zero
        broke_date = date.today()
        days_remaining = 0
    else:
        broke_date = series[0][0] + timedelta(days=int(round(x_zero)))

    return {
        "method": "trend",
        "daily_trend": round(slope, 2),
        "confidence_r2": round(max(r2, 0), 3),
        "days_remaining": round(max(days_remaining, 0), 1),
        "broke_date": broke_date.isoformat(),
        "status": "at_risk",
    }


def predict_broke_date(transactions, current_balance, starting_balance):
    """
    Combines both methods: prefers the trend model once there's enough
    history, otherwise uses the baseline. Always also returns the baseline
    figure for comparison in the UI.
    """
    baseline = baseline_prediction(transactions, current_balance)
    trend = trend_prediction(transactions, starting_balance)

    primary = trend if trend is not None else baseline
    return {
        "primary": primary,
        "baseline": baseline,
        "trend": trend,
    }
