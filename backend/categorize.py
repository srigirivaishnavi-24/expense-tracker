"""
Rule-based transaction categorization.

This simulates the "reads payment notifications + auto-categorizes" feature.
On a real phone build, a notification-listener service would capture the
payment app's notification text (e.g. "Paid ₹240 to Swiggy") and this same
matching step would run on that text. An LLM call could be dropped in later
(see `categorize_with_llm_stub`) to handle merchant names this keyword list
doesn't recognize.
"""
import re

CATEGORY_KEYWORDS = {
    "Food & Dining": [
        "biryani", "swiggy", "zomato", "restaurant", "cafe", "coffee", "pizza",
        "burger", "food", "dining", "dominos", "kfc", "mcdonald", "starbucks",
        "hotel", "dhaba", "canteen", "lunch", "dinner", "breakfast", "snack",
        "bakery", "sweets",
    ],
    "Groceries": [
        "grocery", "groceries", "supermarket", "bigbasket", "blinkit", "zepto",
        "dmart", "vegetables", "kirana", "instamart",
    ],
    "Transport": [
        "uber", "ola", "rapido", "taxi", "auto", "fuel", "petrol", "diesel",
        "metro", "bus", "train", "irctc", "parking", "toll", "fastag",
    ],
    "Shopping": [
        "amazon", "flipkart", "myntra", "ajio", "mall", "shopping", "clothes",
        "shoes", "electronics", "meesho", "nykaa",
    ],
    "Bills & Utilities": [
        "electricity", "water bill", "recharge", "wifi", "broadband", "gas bill",
        "dth", "mobile bill", "jio", "airtel", "vi ", "postpaid", "internet",
    ],
    "Rent & Housing": ["rent", "landlord", "maintenance", "society"],
    "Entertainment": [
        "netflix", "prime video", "hotstar", "spotify", "movie", "cinema",
        "pvr", "inox", "bookmyshow", "game", "gaming", "youtube premium",
    ],
    "Health & Fitness": [
        "pharmacy", "medicine", "doctor", "hospital", "clinic", "gym",
        "fitness", "medplus", "apollo", "diagnostic",
    ],
    "Travel": ["flight", "hotel booking", "makemytrip", "goibibo", "airbnb", "oyo", "trip"],
    "Education": ["course", "udemy", "coursera", "tuition", "books", "school fee", "college"],
    "Salary / Income": ["salary", "stipend", "payout", "refund", "cashback", "freelance", "bonus"],
    "Transfers": ["upi transfer", "sent to", "gpay transfer", "phonepe transfer"],
}

DEFAULT_CATEGORY = "Other"


def categorize(description: str) -> str:
    """Keyword match against a transaction description. Case-insensitive."""
    if not description:
        return DEFAULT_CATEGORY
    text = description.lower()
    for category, keywords in CATEGORY_KEYWORDS.items():
        for kw in keywords:
            if re.search(r"\b" + re.escape(kw.strip()) + r"\b", text) or kw.strip() in text:
                return category
    return DEFAULT_CATEGORY


def categorize_with_llm_stub(description: str) -> str:
    """
    Placeholder for swapping in a real LLM call (e.g. the Anthropic API) to
    categorize merchant strings the keyword list misses. Left as a stub so
    the app works fully offline; wire this up to api.anthropic.com if you
    want smarter categorization for unrecognized merchants.
    """
    return categorize(description)
