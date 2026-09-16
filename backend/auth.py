"""
Authentication: password hashing + server-side session tokens.

Password hashing: PBKDF2-HMAC-SHA256 with a random per-user salt and
600,000 iterations (OWASP's current minimum recommendation for PBKDF2).
This is stdlib-only (hashlib), so the project has zero extra dependencies
to install for auth to work.

Sessions: opaque random tokens (secrets.token_urlsafe) are handed to the
client and stored in the `sessions` table as a SHA-256 hash — the raw
token itself is never persisted, mirroring how you'd never store a raw
password. Sessions expire after SESSION_TTL_DAYS and can be revoked
instantly (logout just deletes the row), which a stateless JWT can't do
without extra infrastructure.
"""
import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import Header, HTTPException

from database import db_cursor

PBKDF2_ITERATIONS = 600_000
SESSION_TTL_DAYS = 7


def hash_password(password: str, salt: str | None = None) -> tuple[str, str]:
    if salt is None:
        salt = secrets.token_hex(16)
    derived = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt.encode("utf-8"), PBKDF2_ITERATIONS
    )
    return derived.hex(), salt


def verify_password(password: str, salt: str, expected_hash: str) -> bool:
    derived, _ = hash_password(password, salt)
    return hmac.compare_digest(derived, expected_hash)


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def create_session(user_id: int) -> str:
    token = secrets.token_urlsafe(32)
    expires_at = (datetime.now(timezone.utc) + timedelta(days=SESSION_TTL_DAYS)).isoformat()
    with db_cursor(commit=True) as cur:
        cur.execute(
            "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
            (_hash_token(token), user_id, expires_at),
        )
    return token


def destroy_session(token: str):
    with db_cursor(commit=True) as cur:
        cur.execute("DELETE FROM sessions WHERE token_hash = ?", (_hash_token(token),))


def _resolve_session(token: str):
    with db_cursor() as cur:
        cur.execute(
            """
            SELECT sessions.user_id, sessions.expires_at, users.id, users.username, users.email
            FROM sessions JOIN users ON users.id = sessions.user_id
            WHERE token_hash = ?
            """,
            (_hash_token(token),),
        )
        row = cur.fetchone()
    if not row:
        return None
    expires_at = datetime.fromisoformat(row["expires_at"])
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if expires_at < datetime.now(timezone.utc):
        with db_cursor(commit=True) as cur:
            cur.execute("DELETE FROM sessions WHERE token_hash = ?", (_hash_token(token),))
        return None
    return {"id": row["id"], "username": row["username"], "email": row["email"]}


def get_current_user(authorization: str | None = Header(default=None)):
    """FastAPI dependency: reads `Authorization: Bearer <token>`, returns the user or 401s."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Not authenticated")
    token = authorization.split(" ", 1)[1].strip()
    user = _resolve_session(token)
    if not user:
        raise HTTPException(status_code=401, detail="Session expired or invalid — please log in again")
    return user


def get_token_from_header(authorization: str | None = Header(default=None)) -> str:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Not authenticated")
    return authorization.split(" ", 1)[1].strip()
