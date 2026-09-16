import re

from pydantic import BaseModel, Field, field_validator
from typing import Optional, Literal
from datetime import date as date_type

# Simple, dependency-free email shape check (project keeps auth stdlib-only).
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class SignupIn(BaseModel):
    username: str = Field(..., min_length=3, max_length=32)
    email: str = Field(..., max_length=254)
    password: str = Field(..., min_length=6, max_length=128)

    @field_validator("username")
    @classmethod
    def username_ok(cls, v: str) -> str:
        v = v.strip()
        if not v.replace("_", "").replace(".", "").isalnum():
            raise ValueError("Username can only contain letters, numbers, '.' and '_'")
        return v

    @field_validator("email")
    @classmethod
    def email_ok(cls, v: str) -> str:
        v = v.strip().lower()
        if not _EMAIL_RE.match(v):
            raise ValueError("Enter a valid email address")
        return v


class LoginIn(BaseModel):
    identifier: str = Field(..., description="Username or email")
    password: str


class UserOut(BaseModel):
    id: int
    username: str
    email: str


class AuthOut(BaseModel):
    token: str
    user: UserOut


class TransactionIn(BaseModel):
    amount: float = Field(..., gt=0)
    type: Literal["income", "expense"]
    category: Optional[str] = None  # auto-categorized if omitted (expenses only)
    description: str = ""
    date: Optional[date_type] = None  # defaults to today


class TransactionUpdate(BaseModel):
    amount: Optional[float] = Field(None, gt=0)
    type: Optional[Literal["income", "expense"]] = None
    category: Optional[str] = None
    description: Optional[str] = None
    date: Optional[date_type] = None


class TransactionOut(BaseModel):
    id: int
    amount: float
    type: str
    category: str
    description: str
    date: str
    created_at: str


class SettingsIn(BaseModel):
    starting_balance: Optional[float] = None
    monthly_budget: Optional[float] = None
    currency: Optional[str] = None


class CategoryBudgetIn(BaseModel):
    category: str
    monthly_limit: float = Field(..., ge=0)


class CategorizeRequest(BaseModel):
    description: str
