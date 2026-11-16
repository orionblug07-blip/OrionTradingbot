"""
Strategy lab: a port of src/services/lab.js. Is there a strategy worth trading?

 1. Download years of daily candles for every symbol from your MT5 terminal.
 2. Split time: the first 65% is for CHOOSING, the last 35% is for JUDGING.
 3. For each family, try every setting on the first part and keep the one with
    the best average result per trade (at least 30 trades).
 4. Run that one setting ONCE on the unseen last part.
 5. PASS only if, there, it has 30+ trades AND the whole 95% range of its
    average result is above zero.

Real-money trading can only be unlocked for a strategy that PASSED.
"""
import json
import math
from datetime import datetime, timezone

from . import config as cfg
from .backtest import simulate, stats, portfolio
from .strategies import FAMILIES, prepare, strategy_id

TRAIN_FRAC = 0.65
MIN_TRADES = 30
SLIPPAGE_PIPS = 0.2  # per side
LAB_BARS = 2700      # about 10 years of daily candles


def _median(xs):
    s = sorted(x for x in xs if x is not None and math.isfinite(x))
    return s[len(s) // 2] if s else None


def cost_for(symbol, candles, point):
    """Round-trip cost in price units: the larger of the broker's candle spread
    (+ slippage) and the cautious table."""
    pip = cfg.pip_size(symbol)
    fallback = cfg.FALLBACK_COST_PIPS.get(cfg.base_name(symbol), cfg.DEFAULT_COST_PIPS) * pip
    sp = _median([c.get("spread") for c in candles])
    from_candles = sp * point + 2 * SLIPPAGE_PIPS * pip if sp is not None and point else 0
    return max(fallback, from_candles)


def load_data(broker, symbols=None, bars=LAB_BARS, log=print):
    data = {}
    for symbol in symbols or cfg.symbols():
        try:
            candles = broker.closed_daily_candles(symbol, bars)
            point = None
            try:
                point = broker.symbol_spec(symbol)["point"]
            except Exception:
                pass
            if len(candles) < 400:
                log(f"{symbol}: only {len(candles)} days of history, skipped")
                continue
            data[symbol] = {"candles": candles, "cost": cost_for(symbol, candles, point)}
            log(f"{symbol}: {len(candles)} days, cost {data[symbol]['cost'] / cfg.pip_size(symbol):.1f} pips")
        except Exception as err:  # noqa: BLE001
            log(f"{symbol}: {err}")
    return data


def verdict_of(test):
    if not test["trades"] or test["trades"] < MIN_TRADES:
        return "TOO FEW TRADES", f"only {test['trades'] or 0} trades on unseen data (need {MIN_TRADES})"
    if test["range95"][0] > 0:
        return "PASS", "made money after costs on data it never saw, and the result is unlikely to be luck"
    if test["expectancy_r"] > 0:
        return "NOT PROVEN", "made a little on unseen data, but the result could easily be luck"
    return "FAIL", "lost money after costs on unseen data"


def _iso(t):
    return datetime.fromtimestamp(t, tz=timezone.utc).strftime("%Y-%m-%d")


def _exp(s):
    return s["expectancy_r"] if s["expectancy_r"] is not None else -math.inf


def run_lab(data, train_frac=TRAIN_FRAC):
    symbols = list(data.keys())
    if not symbols:
        raise ValueError("No price data to test")
    times = sorted({c["time"] for s in symbols for c in data[s]["candles"]})
    split = times[math.floor(len(times) * train_frac)]
    inds = {s: prepare(data[s]["candles"]) for s in symbols}

    families = []
    for family, fam in FAMILIES.items():
        variants = []
        for params in fam["grid"]():
            all_trades = []
            for s in symbols:
                all_trades += simulate(data[s]["candles"], family, params, cost=data[s]["cost"], symbol=s, ind=inds[s])
            train = [t for t in all_trades if t["signal_time"] < split]
            test = [t for t in all_trades if t["signal_time"] >= split]
            variants.append({"params": params, "train": train, "test": test, "train_stats": stats(train)})
        eligible = [v for v in variants if v["train_stats"]["trades"] >= MIN_TRADES]
        pool = eligible or variants
        best = pool[0]
        for v in pool[1:]:
            if _exp(v["train_stats"]) > _exp(best["train_stats"]):
                best = v
        test_stats = stats(best["test"])
        verdict, why = verdict_of(test_stats)
        families.append({
            "family": family,
            "name": fam["name"],
            "chosen": {"id": strategy_id(family, best["params"]), "params": best["params"], "label": fam["describe"](best["params"])},
            "train": best["train_stats"],
            "test": test_stats,
            "portfolio_test": portfolio(best["test"], cfg.LIMITS["risk_pct"], cfg.LIMITS["max_open"]),
            "variants_tried": len(variants),
            "verdict": verdict,
            "why": why,
        })

    # Among PASSes pick the best on the CHOOSING period (picking by the judging
    # period would quietly re-introduce luck).
    by_train = sorted(families, key=lambda f: _exp(f["train"]), reverse=True)
    passed = [f for f in by_train if f["verdict"] == "PASS"]
    pick = passed[0] if passed else by_train[0]
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "rules": {"entry": "next daily open", "stops": "on the server; gaps fill at the open", "train_frac": train_frac,
                  "min_trades": MIN_TRADES, "swaps": "none (swap-free account)"},
        "universe": symbols,
        "costs_pips": {s: round(data[s]["cost"] / cfg.pip_size(s), 1) for s in symbols},
        "period": {"from": _iso(times[0]), "split": _iso(split), "to": _iso(times[-1])},
        "families": families,
        "chosen": {"family": pick["family"], "params": pick["chosen"]["params"], "id": pick["chosen"]["id"],
                   "label": pick["chosen"]["label"], "verdict": pick["verdict"]},
    }


def save_result(result):
    cfg.DATA_DIR.mkdir(parents=True, exist_ok=True)
    cfg.STRATEGY_FILE.write_text(json.dumps(result, indent=2), encoding="utf-8")


def latest_result():
    try:
        return json.loads(cfg.STRATEGY_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def active_strategy():
    """The strategy the trader runs, with its verdict."""
    r = latest_result()
    if r and r.get("chosen") and r["chosen"].get("family") in FAMILIES:
        return {**r["chosen"], "tested_at": r.get("generated_at")}
    f = cfg.FALLBACK_STRATEGY
    return {**f, "label": FAMILIES[f["family"]]["describe"](f["params"]), "verdict": "NOT TESTED", "tested_at": None}


def summary(r):
    if not r:
        return "No lab result yet. Run:  python jijazy.py lab"
    icon = {"PASS": "✅", "NOT PROVEN": "🟡", "FAIL": "❌", "TOO FEW TRADES": "⚪"}
    lines = [f"🧪 Strategy lab ({r['period']['from']} → {r['period']['to']})",
             f"Chose settings on data up to {r['period']['split']}, judged on the rest.", ""]
    for f in r["families"]:
        t = f["test"]
        lines.append(f"{icon.get(f['verdict'], '•')} {f['name']}: {f['verdict']}")
        lines.append(f"   {f['chosen']['label']}")
        if t["trades"]:
            sign = "+" if t["expectancy_r"] > 0 else ""
            lines.append(f"   Unseen data: {t['trades']} trades · {t['win_rate_pct']}% wins · avg {sign}{t['expectancy_r']}R "
                         f"(likely {t['range95'][0]} to {t['range95'][1]})")
        pt = f.get("portfolio_test") or {}
        if pt.get("taken"):
            sign = "+" if pt["return_pct"] > 0 else ""
            lines.append(f"   At {cfg.LIMITS['risk_pct']}% risk: {sign}{pt['return_pct']}%, worst drop {pt['max_drawdown_pct']}%")
    lines += ["", f"▶️ In use: {r['chosen']['label']} ({r['chosen']['verdict']})"]
    if r["chosen"]["verdict"] != "PASS":
        lines.append("Nothing passed, so real-money trading stays locked. Demo trading continues as a forward test.")
    lines.append("Past results are not a promise.")
    return "\n".join(lines)
