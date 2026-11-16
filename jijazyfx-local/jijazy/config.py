"""
All trading settings in one place: symbols, safety limits, and what it takes
to unlock real-money trading. Same values as the old Vercel/MetaApi bot.
"""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
STRATEGY_FILE = DATA_DIR / "fx-strategy.json"
STATE_FILE = DATA_DIR / "state.json"
LOG_FILE = DATA_DIR / "jijazy.log"
LOCK_FILE = DATA_DIR / "run.lock"


def load_env(path=ROOT / ".env"):
    """Tiny .env reader (KEY=VALUE lines). Real environment variables win."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k, v = k.strip(), v.strip().strip('"').strip("'")
        if k and k not in os.environ:
            os.environ[k] = v


DEFAULT_SYMBOLS = ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF", "NZDUSD", "XAUUSD"]


def symbols():
    env = [s.strip() for s in os.environ.get("FX_SYMBOLS", "").split(",") if s.strip()]
    return env or list(DEFAULT_SYMBOLS)


def pip_size(symbol):
    """JPY pairs: 0.01. Gold: 0.1. Silver: 0.01. Everything else: 0.0001."""
    s = symbol.upper()
    if s.startswith("XAU"):
        return 0.1
    if s.startswith("XAG"):
        return 0.01
    if "JPY" in s:
        return 0.01
    return 0.0001


# Typical round-trip cost in pips (spread + a little slippage), used by the lab
# when it is higher than the broker's own candle spread. Deliberately cautious.
FALLBACK_COST_PIPS = {
    "EURUSD": 1.2, "GBPUSD": 1.6, "USDJPY": 1.5, "AUDUSD": 1.4, "USDCAD": 2.0,
    "USDCHF": 2.0, "NZDUSD": 2.0, "XAUUSD": 4.0,
}
DEFAULT_COST_PIPS = 2.5


def base_name(symbol):
    """'EURUSD.m' -> 'EURUSD' (for the cost table)."""
    letters = "".join(ch for ch in symbol if ch.isalpha()).upper()
    return letters[:6]


# Every order carries this magic number, so the bot never touches your own trades.
MAGIC = 20261115
COMMENT = "JijazyFX"

LIMITS = {
    "risk_pct": 1,          # % of equity lost if a trade hits its first stop
    "max_open": 4,          # at most this many bot positions at once
    "max_per_currency": 2,  # e.g. at most 2 positions that are long USD
    "max_leverage": 5,      # total position value <= 5 x equity
    "daily_loss_pct": 3,    # equity fell this much since the last run -> no new trades
}

GATE = {
    "research_verdict": "PASS",  # from the lab
    "forward_days": 56,          # a DEMO account has auto-traded 8+ weeks
    "forward_trades": 20,        # with at least 20 closed trades
    "forward_profit": True,      # and made money after costs
}

# Used until the lab has run. Demo only: without a PASS real money stays locked.
FALLBACK_STRATEGY = {"family": "donchian", "params": {"entryN": 55, "exitN": 20}, "id": "donchian:55-20"}

LIVE_CONFIRM = "I UNDERSTAND REAL MONEY"


def dry_run():
    return os.environ.get("AUTOTRADE_DRY_RUN", "").strip().lower() == "true"
