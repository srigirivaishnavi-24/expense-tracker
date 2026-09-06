from pydantic import BaseModel, Field
from typing import Optional, Literal
from datetime import date as date_type


class TransactionIn(BaseModel):
    amount: float = Field(..., gt=0)
    type: Literal["income", "expense"]
    category: Optional[str] = None  # auto-categorized if omitted (expenses only)
    description: str = ""
    date: Optional[date_type] = None  # defaults to today


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
