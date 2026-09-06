"""
Budget alerts + "Roast Mode".

Roast Mode is implemented as in-app alerts here (this environment can't
register a background notification listener or send WhatsApp messages).
To push these out for real, POST the returned `message` strings to the
WhatsApp Business API (or Twilio's WhatsApp API) on a daily cron — the
`severity` field maps cleanly to how urgently you'd want to notify.
"""
import random
from datetime import date, timedelta
from collections import defaultdict

ROAST_TEMPLATES = [
    "{category} again? That's {count} orders this week for {amount}. Your wallet is filing a complaint.",
    "You've spent {amount} on {category} this week ({count} times). At this rate {category} owes you rent.",
    "{count} {category} transactions this week, {amount} total. Bold strategy — let's see if it pays off.",
    "Your {category} spending this week: {amount} across {count} orders. Impressive dedication, terrible timing.",
    "{amount} on {category} in 7 days. That's not a habit anymore, that's a lifestyle you can't afford.",
]


def generate_roast(category: str, count: int, amount: float, currency: str = "₹") -> str:
    template = random.choice(ROAST_TEMPLATES)
    return template.format(category=category, count=count, amount=f"{currency}{amount:,.0f}")


def build_alerts(transactions, category_budgets, monthly_budget, current_balance, broke_date_info, currency="₹"):
    alerts = []
    today = date.today()
    week_ago = today - timedelta(days=7)
    month_start = today.replace(day=1)

    # --- Weekly category frequency -> Roast Mode ---
    week_by_cat = defaultdict(lambda: {"count": 0, "amount": 0.0})
    for t in transactions:
        if t["type"] != "expense":
            continue
        d = date.fromisoformat(t["date"])
        if d >= week_ago:
            week_by_cat[t["category"]]["count"] += 1
            week_by_cat[t["category"]]["amount"] += t["amount"]

    for category, stats in week_by_cat.items():
        if stats["count"] >= 3:
            alerts.append({
                "type": "roast",
                "severity": "info",
                "category": category,
                "message": generate_roast(category, stats["count"], stats["amount"], currency),
            })

    # --- Category budget overrun ---
    month_by_cat = defaultdict(float)
    for t in transactions:
        if t["type"] != "expense":
            continue
        if date.fromisoformat(t["date"]) >= month_start:
            month_by_cat[t["category"]] += t["amount"]

    for category, limit in category_budgets.items():
        spent = month_by_cat.get(category, 0.0)
        if limit > 0 and spent > limit:
            over_pct = round((spent / limit - 1) * 100)
            alerts.append({
                "type": "budget_overrun",
                "severity": "warning",
                "category": category,
                "message": f"{category} is {over_pct}% over its monthly limit of {currency}{limit:,.0f} "
                            f"(spent {currency}{spent:,.0f} so far).",
            })

    # --- Overall monthly budget ---
    total_month_spent = sum(month_by_cat.values())
    if monthly_budget and total_month_spent > monthly_budget:
        alerts.append({
            "type": "budget_overrun",
            "severity": "warning",
            "category": "Overall",
            "message": f"You've crossed your monthly budget of {currency}{monthly_budget:,.0f} "
                       f"— total spend so far is {currency}{total_month_spent:,.0f}.",
        })

    # --- Broke date urgency ---
    primary = broke_date_info.get("primary") or {}
    if primary.get("broke_date"):
        days_remaining = primary.get("days_remaining")
        if days_remaining is not None and days_remaining <= 14:
            severity = "critical" if days_remaining <= 7 else "warning"
            alerts.append({
                "type": "broke_date",
                "severity": severity,
                "category": "Overall",
                "message": f"At your current burn rate, your balance hits zero around "
                           f"{primary['broke_date']} — that's about {days_remaining} days away.",
            })

    # --- Low balance ---
    if 0 < current_balance <= 500:
        alerts.append({
            "type": "low_balance",
            "severity": "critical",
            "category": "Overall",
            "message": f"Balance is down to {currency}{current_balance:,.0f}. Time to pause non-essential spending.",
        })
    elif current_balance <= 0:
        alerts.append({
            "type": "low_balance",
            "severity": "critical",
            "category": "Overall",
            "message": "Balance is at or below zero. You're already at your Broke Date.",
        })

    severity_rank = {"critical": 0, "warning": 1, "info": 2}
    alerts.sort(key=lambda a: severity_rank.get(a["severity"], 3))
    return alerts
