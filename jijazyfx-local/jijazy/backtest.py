"""
Backtester: a port of src/services/backtest.js. Replays daily candles exactly
the way the live trader trades:

  Signal   on the daily close
  Entry    next day's OPEN, paying half the round-trip cost (spread + slippage)
  Stop     filled at the stop, or at the open if the price gaps through it,
           paying the other half of the cost
  Trail    after each daily close the stop tightens, never loosens
  Results  in R: R = the distance from entry to the first stop

Octa accounts are swap-free, so no overnight financing is charged.
"""
import math

from .strategies import FAMILIES, prepare, initial_stop, next_stop


def simulate(c, family, p, cost=0.0, start_time=None, end_time=None, symbol=None, ind=None):
    fam = FAMILIES.get(family)
    if not fam:
        raise ValueError(f"Unknown family {family}")
    ind = ind or prepare(c)
    half = (cost or 0) / 2
    lo = -math.inf if start_time is None else start_time
    hi = math.inf if end_time is None else end_time
    trades = []
    pos = None
    for j in range(fam["warmup"](p), len(c)):
        bar = c[j]
        # 1) open a pending entry at this bar's open
        if pos and pos["pending"]:
            entry = bar["open"] + half if pos["side"] == "buy" else bar["open"] - half
            stop = initial_stop(fam, ind, pos["signal_idx"], pos["side"], p, entry)
            risk = abs(entry - stop) if stop is not None else 0
            if stop is None or not risk > 0:
                pos = None
            else:
                pos.update(pending=False, entry=entry, stop=stop, stop0=stop, risk=risk, entry_idx=j, entry_time=bar["time"])
        # 2) stop hit during this bar?
        if pos and not pos["pending"]:
            fill = None
            if pos["side"] == "buy":
                if bar["open"] <= pos["stop"]:
                    fill = bar["open"]
                elif bar["low"] <= pos["stop"]:
                    fill = pos["stop"]
            elif bar["open"] >= pos["stop"]:
                fill = bar["open"]
            elif bar["high"] >= pos["stop"]:
                fill = pos["stop"]
            if fill is not None:
                trades.append(_close(pos, fill, bar["time"], j, half, symbol))
                pos = None
            else:
                # 3) trail after the close
                pos["stop"] = next_stop(fam, ind, j, pos["side"], p, pos["entry_idx"], pos["stop"])
        # 4) new signal on this close -> enter at next open
        if not pos and j < len(c) - 1 and lo <= bar["time"] < hi:
            side = fam["signal"](ind, j, p)
            if side:
                pos = {"pending": True, "side": side, "signal_idx": j, "signal_time": bar["time"]}
    if pos and not pos["pending"]:
        last = c[-1]
        t = _close(pos, last["close"], last["time"], len(c) - 1, half, symbol)
        t["open"] = True
        trades.append(t)
    return trades


def _close(pos, fill, time, idx, half, symbol):
    exit_px = fill - half if pos["side"] == "buy" else fill + half
    move = exit_px - pos["entry"] if pos["side"] == "buy" else pos["entry"] - exit_px
    return {
        "symbol": symbol, "side": pos["side"],
        "signal_time": pos["signal_time"], "entry_time": pos["entry_time"], "exit_time": time,
        "entry": pos["entry"], "exit": exit_px, "stop0": pos["stop0"],
        "r": move / pos["risk"],
        "risk_pct": pos["risk"] / pos["entry"] * 100,
        "bars": idx - pos["entry_idx"] + 1,
    }


def _r3(x):
    return round(x * 1000) / 1000


def stats(trades):
    n = len(trades)
    if not n:
        return {"trades": 0, "win_rate_pct": None, "expectancy_r": None, "range95": None, "profit_factor": None,
                "avg_bars": None, "max_drawdown_r": None, "best_r": None, "worst_r": None}
    rs = [t["r"] for t in trades]
    mean = sum(rs) / n
    sd = math.sqrt(sum((r - mean) ** 2 for r in rs) / (n - 1)) if n > 1 else 0
    se = sd / math.sqrt(n)
    wins = [r for r in rs if r > 0]
    gain = sum(wins)
    loss = -sum(r for r in rs if r <= 0)
    eq = peak = dd = 0.0
    for t in sorted(trades, key=lambda t: t["exit_time"]):
        eq += t["r"]
        peak = max(peak, eq)
        dd = max(dd, peak - eq)
    return {
        "trades": n,
        "win_rate_pct": round(len(wins) / n * 1000) / 10,
        "expectancy_r": _r3(mean),
        "range95": [_r3(mean - 1.96 * se), _r3(mean + 1.96 * se)],
        "profit_factor": round(gain / loss * 100) / 100 if loss > 0 else None,
        "avg_bars": round(sum(t["bars"] for t in trades) / n),
        "max_drawdown_r": _r3(dd),
        "best_r": _r3(max(rs)),
        "worst_r": _r3(min(rs)),
    }


def portfolio(trades, risk_pct=1, max_open=4):
    """Risk risk_pct of current equity per trade, at most max_open at once."""
    events = sorted(trades, key=lambda t: t["entry_time"])
    state = {"equity": 100.0, "peak": 100.0, "dd": 0.0}
    taken = 0
    open_ = []

    def settle(until):
        open_.sort(key=lambda o: o["t"]["exit_time"])
        while open_ and open_[0]["t"]["exit_time"] <= until:
            o = open_.pop(0)
            state["equity"] += o["risk_money"] * o["t"]["r"]
            state["peak"] = max(state["peak"], state["equity"])
            state["dd"] = max(state["dd"], (state["peak"] - state["equity"]) / state["peak"])

    for t in events:
        settle(t["entry_time"])
        if len(open_) >= max_open or any(o["t"]["symbol"] == t["symbol"] for o in open_):
            continue
        open_.append({"t": t, "risk_money": state["equity"] * risk_pct / 100})
        taken += 1
    settle(math.inf)
    return {"taken": taken, "return_pct": round((state["equity"] - 100) * 10) / 10, "max_drawdown_pct": round(state["dd"] * 1000) / 10}
