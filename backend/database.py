"""
SQLite database layer for the Expense Tracker.
Uses the stdlib sqlite3 module directly — no ORM, kept intentionally simple.
"""
import sqlite3
from pathlib import Path
from contextlib import contextmanager

DB_PATH = Path(__file__).parent / "expense_tracker.db"


def get_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


@contextmanager
def db_cursor(commit: bool = False):
    conn = get_connection()
    try:
        cur = conn.cursor()
        yield cur
        if commit:
            conn.commit()
    finally:
        conn.close()


def init_db():
    with db_cursor(commit=True) as cur:
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS transactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                amount REAL NOT NULL,
                type TEXT NOT NULL CHECK(type IN ('income', 'expense')),
                category TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                date TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
            """
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS settings (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                starting_balance REAL NOT NULL DEFAULT 0,
                monthly_budget REAL NOT NULL DEFAULT 0,
                currency TEXT NOT NULL DEFAULT '₹'
            )
            """
        )
        cur.execute("SELECT COUNT(*) as c FROM settings")
        if cur.fetchone()["c"] == 0:
            cur.execute(
                "INSERT INTO settings (id, starting_balance, monthly_budget, currency) VALUES (1, 0, 0, '₹')"
            )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS category_budgets (
                category TEXT PRIMARY KEY,
                monthly_limit REAL NOT NULL
            )
            """
        )
