"""
Everything the bot remembers, in one JSON file (data/state.json), instead of
the old Redis database. Kept per MT5 login, so a demo account's forward test
and a real account's trades never mix.

{
  "flags":    {"paused": false, "live_unlocked": false},
  "last_bar": 1763337600,
  "accounts": {
    "213953907": {
      "mode": "demo", "server": "OctaFX-Demo",
      "first_trade": "2026-11-17T09:00:00+00:00",
      "last_equity": 10000.0,
      "open":   {"123456": {"symbol": "EURUSD", "side": "buy", "opened_at": ..., "risk_money": 100.0}},
      "closed": [{...}, ...],          # newest first
      "did":    {"2026-11-17:EURUSD": 1}  # one entry per symbol per day
    }
  }
}
"""
import json
import os
import time
from datetime import datetime, timezone

from . import config as cfg

DAY = 86400


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def load():
    try:
        s = json.loads(cfg.STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        s = {}
    s.setdefault("flags", {"paused": False, "live_unlocked": False})
    s.setdefault("last_bar", 0)
    s.setdefault("accounts", {})
    return s


def save(s):
    """Write atomically, so a crash never leaves a half-written file."""
    cfg.DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = cfg.STATE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(s, indent=2), encoding="utf-8")
    os.replace(tmp, cfg.STATE_FILE)


def account(s, acct):
    a = s["accounts"].setdefault(acct["login"], {})
    a["mode"] = acct["mode"]
    a["server"] = acct["server"]
    for k, v in (("open", {}), ("closed", []), ("did", {}), ("first_trade", None), ("last_equity", None)):
        a.setdefault(k, v)
    return a


def prune_did(a, today):
    """Forget 'already entered' marks older than a few days."""
    for k in list(a["did"]):
        if k[:10] < today and (datetime.fromisoformat(today) - datetime.fromisoformat(k[:10])).days > 4:
            del a["did"][k]


def forward_stats(a):
    trades = a.get("closed", [])
    known = [t for t in trades if t.get("profit") is not None]
    rs = [t["r"] for t in trades if t.get("r") is not None]
    first = a.get("first_trade")
    days = int((time.time() - datetime.fromisoformat(first).timestamp()) // DAY) if first else 0
    return {
        "since": first, "days": days, "closed": len(trades),
        "wins": len([t for t in known if t["profit"] > 0]),
        "profit": round(sum(t["profit"] for t in known), 2),
        "avg_r": round(sum(rs) / len(rs), 2) if rs else None,
    }


class RunLock:
    """Stops two runs (e.g. a scheduled one and a manual one) trading at once."""

    def __init__(self, stale_after=15 * 60):
        self.stale_after = stale_after
        self.held = False

    def __enter__(self):
        cfg.DATA_DIR.mkdir(parents=True, exist_ok=True)
        try:
            if cfg.LOCK_FILE.exists() and time.time() - cfg.LOCK_FILE.stat().st_mtime > self.stale_after:
                cfg.LOCK_FILE.unlink()
            fd = os.open(cfg.LOCK_FILE, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(fd, str(os.getpid()).encode())
            os.close(fd)
            self.held = True
        except FileExistsError:
            self.held = False
        return self

    def __exit__(self, *exc):
        if self.held:
            try:
                cfg.LOCK_FILE.unlink()
            except OSError:
                pass
