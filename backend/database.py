"""
SQLite database layer for the Expense Tracker.
Uses the stdlib sqlite3 module directly — no ORM, kept intentionally simple.

Schema is multi-user: every transaction, settings row, and category budget
belongs to a user_id. Auth sessions are stored server-side (hashed tokens)
so a session can be revoked instantly on logout.
"""
import sqlite3
import shutil
from datetime import datetime
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


def _needs_migration() -> bool:
    """
    Detects schema versions this code can't run against, so we don't
    crash on an old database file:
      - pre-auth: transactions table with no user_id column
      - pre-email: users table with no email column (email/username login)
    """
    if not DB_PATH.exists():
        return False
    with db_cursor() as cur:
        cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='transactions'")
        if cur.fetchone():
            cur.execute("PRAGMA table_info(transactions)")
            cols = {row["name"] for row in cur.fetchall()}
            if "user_id" not in cols:
                return True

        cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='users'")
        if cur.fetchone():
            cur.execute("PRAGMA table_info(users)")
            cols = {row["name"] for row in cur.fetchall()}
            if "email" not in cols:
                return True

    return False


def _archive_old_db():
    """Old single-user DB found — back it up rather than silently discard it."""
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup = DB_PATH.with_name(f"expense_tracker.pre-auth-backup.{stamp}.db")
    shutil.move(str(DB_PATH), str(backup))


def init_db():
    if _needs_migration():
        _archive_old_db()

    with db_cursor(commit=True) as cur:
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE,
                email TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                password_salt TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
            """
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                expires_at TEXT NOT NULL
            )
            """
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS transactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                amount REAL NOT NULL,
                type TEXT NOT NULL CHECK(type IN ('income', 'expense')),
                category TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                date TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
            """
        )
        cur.execute("CREATE INDEX IF NOT EXISTS idx_txn_user ON transactions(user_id)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_txn_user_date ON transactions(user_id, date)")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS settings (
                user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                starting_balance REAL NOT NULL DEFAULT 0,
                monthly_budget REAL NOT NULL DEFAULT 0,
                currency TEXT NOT NULL DEFAULT '₹'
            )
            """
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS category_budgets (
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                category TEXT NOT NULL,
                monthly_limit REAL NOT NULL,
                PRIMARY KEY (user_id, category)
            )
            """
        )


def ensure_user_settings(user_id: int):
    """Every new user gets a default settings row so downstream reads never 404."""
    with db_cursor(commit=True) as cur:
        cur.execute("SELECT 1 FROM settings WHERE user_id = ?", (user_id,))
        if not cur.fetchone():
            cur.execute(
                "INSERT INTO settings (user_id, starting_balance, monthly_budget, currency) VALUES (?, 0, 0, '₹')",
                (user_id,),
            )
