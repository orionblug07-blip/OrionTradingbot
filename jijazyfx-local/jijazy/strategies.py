"""
Forex strategy families (daily candles, long AND short).
A line-by-line port of src/strategies/fx.js from the old bot, shared by the lab
and the live trader, so what is tested is exactly what runs.

A candle is a dict: {time (seconds), open, high, low, close, spread}.

  donchian  Close breaks the N-day high (buy) or N-day low (sell).
            Stop/trail = the M-day low (buy) or M-day high (sell).
  emaTrend  Fast EMA above slow EMA and the close crosses back above the fast
            EMA (buy); mirror for sell. Trail = best close - k*ATR.
  tsmom     The L-day return turns positive (buy) or negative (sell), and the
            price is on the same side of its 100-day EMA. Trail = k*ATR.
"""
import math

MIN_STOP_ATR = 0.5  # never place a stop closer than half a day's average range


def ema(values, n):
    out = [None] * len(values)
    k = 2 / (n + 1)
    prev = None
    for i in range(len(values)):
        if i == n - 1:
            prev = sum(values[:n]) / n
        elif i >= n:
            prev = values[i] * k + prev * (1 - k)
        if i >= n - 1:
            out[i] = prev
    return out


def atr(c, n=20):
    """Wilder ATR(n), same seeding as the JavaScript version."""
    out = [None] * len(c)
    prev = 0.0
    for i in range(1, len(c)):
        tr = max(c[i]["high"] - c[i]["low"], abs(c[i]["high"] - c[i - 1]["close"]), abs(c[i]["low"] - c[i - 1]["close"]))
        if i < n:
            prev += tr
            if i == n - 1:
                prev /= n - 1
                out[i] = prev
            continue
        prev = (prev * (n - 1) + tr) / n
        out[i] = prev
    return out


def prior_high(c, i, n):
    if i - n < 0:
        return None
    return max(c[j]["high"] for j in range(i - n, i))


def prior_low(c, i, n):
    if i - n < 0:
        return None
    return min(c[j]["low"] for j in range(i - n, i))


def low_incl(c, i, n):
    if i - n + 1 < 0:
        return None
    return min(c[j]["low"] for j in range(i - n + 1, i + 1))


def high_incl(c, i, n):
    if i - n + 1 < 0:
        return None
    return max(c[j]["high"] for j in range(i - n + 1, i + 1))


def prepare(c):
    """Indicators for one symbol (computed once, shared by every variant)."""
    close = [x["close"] for x in c]
    return {"c": c, "close": close, "ema": {n: ema(close, n) for n in (10, 20, 50, 100, 200)}, "atr": atr(c, 20)}


def atr_trail(ind, i, side, k, entry_idx):
    a = ind["atr"][i]
    if a is None:
        return None
    start = max(0, entry_idx if entry_idx is not None else i)
    window = ind["close"][start:i + 1]
    best = max(window) if side == "buy" else min(window)
    return best - k * a if side == "buy" else best + k * a


# ─── Families ────────────────────────────────────────────────────────────────
def _donchian_grid():
    return [{"entryN": e, "exitN": x} for e in (20, 55, 100) for x in (10, 20, 50) if x < e]


def _donchian_signal(ind, i, p):
    c = ind["c"]
    hi, lo = prior_high(c, i, p["entryN"]), prior_low(c, i, p["entryN"])
    if hi is None:
        return None
    if c[i]["close"] > hi:
        return "buy"
    if c[i]["close"] < lo:
        return "sell"
    return None


def _donchian_trail(ind, i, side, p, entry_idx=None):
    return low_incl(ind["c"], i, p["exitN"]) if side == "buy" else high_incl(ind["c"], i, p["exitN"])


def _ema_grid():
    return [{"fast": f, "slow": s, "k": k} for f, s in ((10, 50), (20, 100), (50, 200)) for k in (2, 3, 4)]


def _ema_signal(ind, i, p):
    f, s, cl = ind["ema"][p["fast"]], ind["ema"][p["slow"]], ind["close"]
    if i < 1 or f[i] is None or s[i] is None or f[i - 1] is None:
        return None
    if f[i] > s[i] and cl[i - 1] <= f[i - 1] and cl[i] > f[i]:
        return "buy"
    if f[i] < s[i] and cl[i - 1] >= f[i - 1] and cl[i] < f[i]:
        return "sell"
    return None


def _tsmom_grid():
    return [{"lookback": l, "k": k} for l in (60, 120, 250) for k in (3, 4, 5)]


def _tsmom_signal(ind, i, p):
    cl, e = ind["close"], ind["ema"][100]
    L = p["lookback"]
    if i - L - 1 < 0 or e[i] is None:
        return None
    r = cl[i] / cl[i - L] - 1
    r_prev = cl[i - 1] / cl[i - 1 - L] - 1
    if r > 0 and r_prev <= 0 and cl[i] > e[i]:
        return "buy"
    if r < 0 and r_prev >= 0 and cl[i] < e[i]:
        return "sell"
    return None


def _fmt(x):
    return str(int(x)) if float(x).is_integer() else str(x)


FAMILIES = {
    "donchian": {
        "name": "Breakout",
        "describe": lambda p: f"Breakout: buy a close above the {p['entryN']}-day high, sell a close below the {p['entryN']}-day low; stop trails the {p['exitN']}-day low/high",
        "grid": _donchian_grid,
        "warmup": lambda p: max(p["entryN"], p["exitN"]) + 21,
        "signal": _donchian_signal,
        "trail": _donchian_trail,
    },
    "emaTrend": {
        "name": "Trend pullback",
        "describe": lambda p: f"Trend pullback: EMA{p['fast']} above EMA{p['slow']} and the close crosses back above EMA{p['fast']} (buy), mirror for sell; stop trails {_fmt(p['k'])}xATR from the best close",
        "grid": _ema_grid,
        "warmup": lambda p: p["slow"] + 21,
        "signal": _ema_signal,
        "trail": lambda ind, i, side, p, entry_idx=None: atr_trail(ind, i, side, p["k"], entry_idx),
    },
    "tsmom": {
        "name": "Momentum",
        "describe": lambda p: f"Momentum: the {p['lookback']}-day return turns positive above the 100-day EMA (buy) or negative below it (sell); stop trails {_fmt(p['k'])}xATR",
        "grid": _tsmom_grid,
        "warmup": lambda p: max(p["lookback"] + 1, 100) + 21,
        "signal": _tsmom_signal,
        "trail": lambda ind, i, side, p, entry_idx=None: atr_trail(ind, i, side, p["k"], entry_idx),
    },
}


def initial_stop(fam, ind, i, side, p, entry_price):
    """Initial stop for a signal on bar i, filled at entry_price."""
    stop = fam["trail"](ind, i, side, p, i)
    min_dist = MIN_STOP_ATR * (ind["atr"][i] or 0)
    if stop is None:
        return None
    return min(stop, entry_price - min_dist) if side == "buy" else max(stop, entry_price + min_dist)


def next_stop(fam, ind, i, side, p, entry_idx, current):
    """Tighten-only update of an existing stop."""
    cand = fam["trail"](ind, i, side, p, entry_idx)
    if cand is None:
        return current
    return max(current, cand) if side == "buy" else min(current, cand)


def strategy_id(family, params):
    return f"{family}:" + "-".join(_fmt(v) for v in params.values())


def is_finite(x):
    return isinstance(x, (int, float)) and math.isfinite(x)
