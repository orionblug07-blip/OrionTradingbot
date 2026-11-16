"""
The daily trader: a port of src/services/autoTrader.js for one MT5 account
running on this PC. Run it every hour (Windows Task Scheduler); it acts only
once per new daily candle:

 1. Read the latest CLOSED daily candles from MT5 and work out today's signals
    with the strategy the lab chose.
 2. Report positions that closed since the last run (stop hit on the server).
 3. Tighten each open position's stop (never loosen) on the broker's server.
 4. Open new positions for today's signals, sized so hitting the first stop
    loses 1% of equity, with the stop sent in the same order.

Safety limits (config.py): 1% risk per trade, at most 4 positions, at most 2
leaning the same way on one currency, total position value <= 5x equity, no
new trades after a 3% drop since the last run, one entry per symbol per day.
`pause` stops new trades. Real-money accounts are skipped until `unlock-live`.
"""
import math
import os
from datetime import datetime, timezone

from . import config as cfg
from . import lab
from . import state as st
from . import telegram as tg
from .broker import BrokerError
from .strategies import FAMILIES, prepare, initial_stop, next_stop

DAY = 86400


# ─── Formatting ──────────────────────────────────────────────────────────────
def decimals(symbol):
    pip = cfg.pip_size(symbol)
    return 2 if pip >= 0.1 else 3 if pip >= 0.01 else 5


def px(symbol, x):
    return f"{x:.{decimals(symbol)}f}" if isinstance(x, (int, float)) and math.isfinite(x) else "—"


def money(x, ccy="USD"):
    if x is None:
        return "—"
    sign = "−" if x < 0 else ""
    return f"{sign}${abs(x):.2f}" if ccy == "USD" else f"{sign}{abs(x):.2f} {ccy}"


def side_word(side):
    return "BUY" if side == "buy" else "SELL"


def currencies(symbol):
    letters = "".join(ch for ch in symbol if ch.isalpha()).upper()
    return letters[:3], letters[3:6]


def exposure(items):
    """{'EUR+': 1, 'USD-': 1} style counts for a list of (symbol, side)."""
    m = {}
    for symbol, side in items:
        b, q = currencies(symbol)
        sb, sq = ("+", "-") if side == "buy" else ("-", "+")
        m[b + sb] = m.get(b + sb, 0) + 1
        m[q + sq] = m.get(q + sq, 0) + 1
    return m


def floor_step(v, step):
    return math.floor(v / step + 1e-9) * step if step > 0 else v


def round_tick(v, tick):
    return round(v / tick) * tick if tick > 0 else v


def step_decimals(step):
    return max(0, -math.floor(math.log10(step))) if step > 0 else 2


def bar_day(t):
    return datetime.fromtimestamp(t, tz=timezone.utc).strftime("%Y-%m-%d")


# ─── Signals ─────────────────────────────────────────────────────────────────
def compute_signals(broker, strategy):
    fam = FAMILIES[strategy["family"]]
    warm = fam["warmup"](strategy["params"])
    out = {}
    for symbol in cfg.symbols():
        try:
            candles = broker.closed_daily_candles(symbol, max(300, warm + 60))
            if len(candles) < warm + 2:
                out[symbol] = {"error": "not enough history"}
                continue
            ind = prepare(candles)
            i = len(candles) - 1
            out[symbol] = {"candles": candles, "ind": ind, "i": i, "signal": fam["signal"](ind, i, strategy["params"]),
                           "last_time": candles[i]["time"], "close": candles[i]["close"]}
        except Exception as err:  # noqa: BLE001
            out[symbol] = {"error": str(err)}
    return out


# ─── Bookkeeping ─────────────────────────────────────────────────────────────
def record_closed(broker, a, position_id, info, fallback_profit=None):
    profit = None
    try:
        profit = broker.position_result(position_id)
    except Exception:  # noqa: BLE001
        pass
    if profit is None:
        profit = fallback_profit
    risk = info.get("risk_money")
    rec = {"position_id": position_id, "symbol": info.get("symbol"), "side": info.get("side"),
           "opened_at": info.get("opened_at"), "closed_at": st.now_iso(), "profit": profit,
           "r": round(profit / risk, 2) if profit is not None and risk else None}
    a["closed"].insert(0, rec)
    del a["closed"][2000:]
    a["open"].pop(position_id, None)
    return rec


def live_gate(s):
    """What real-money trading needs before `unlock-live` works."""
    reasons = []
    strat = lab.active_strategy()
    if strat["verdict"] != cfg.GATE["research_verdict"]:
        reasons.append(f"the lab hasn't given the strategy a PASS (it says {strat['verdict']})")
    demos = [a for a in s["accounts"].values() if a.get("mode") == "demo"]
    best = max(demos, key=lambda a: len(a.get("closed", [])), default=None)
    fwd = st.forward_stats(best) if best else {"days": 0, "closed": 0, "profit": 0}
    if not best:
        reasons.append("no demo account has run the forward test yet")
    if fwd["days"] < cfg.GATE["forward_days"]:
        reasons.append(f"the demo forward test has run {fwd['days']} of {cfg.GATE['forward_days']} days")
    if fwd["closed"] < cfg.GATE["forward_trades"]:
        reasons.append(f"it has {fwd['closed']} of {cfg.GATE['forward_trades']} closed trades")
    if cfg.GATE["forward_profit"] and not fwd["profit"] > 0:
        reasons.append("it hasn't made money yet")
    return {"ok": not reasons, "reasons": reasons, "strategy": strat, "forward": fwd}


# ─── Managing the account ────────────────────────────────────────────────────
def manage(broker, a, acct, sig, strategy, ctx, dry=False, persist=lambda: None):
    fam = FAMILIES[strategy["family"]]
    p = strategy["params"]
    L = cfg.LIMITS
    rep = {"opened": [], "moved": [], "closed_now": [], "stopped_out": [], "skipped": [],
           "equity": acct["equity"], "ccy": acct["currency"]}
    equity = acct["equity"]
    mine = broker.positions()

    # a) positions that closed since the last run (stop hit on the server)
    now_ids = {x["id"] for x in mine}
    for pid, info in list(a["open"].items()):
        if pid not in now_ids:
            rep["stopped_out"].append(record_closed(broker, a, pid, info))
    for x in mine:
        if x["id"] not in a["open"]:
            a["open"][x["id"]] = {"symbol": x["symbol"], "side": x["side"],
                                  "opened_at": datetime.fromtimestamp(x["time"], tz=timezone.utc).isoformat(), "risk_money": None}
    persist()

    # b) tighten stops
    for x in list(mine):
        s = sig.get(x["symbol"])
        if not s or s.get("error"):
            continue
        side = x["side"]
        entry_idx = next((k for k, c in enumerate(s["candles"]) if c["time"] + DAY > x["time"]), s["i"])
        current = x["sl"] if x["sl"] else (-math.inf if side == "buy" else math.inf)
        target = next_stop(fam, s["ind"], s["i"], side, p, entry_idx, current)
        if not math.isfinite(target):
            continue
        try:
            spec = broker.symbol_spec(x["symbol"])
            target = round(round_tick(target, spec["tick_size"]), spec["digits"])
            now_px = x["current_price"]
            crossed = now_px <= target if side == "buy" else now_px >= target
            if crossed:
                if not dry:
                    broker.close_position(x, spec)
                    record_closed(broker, a, x["id"], {**a["open"].get(x["id"], {}), "symbol": x["symbol"], "side": side},
                                  fallback_profit=x["profit"])
                    mine.remove(x)
                    persist()
                rep["closed_now"].append({"symbol": x["symbol"], "side": side, "price": now_px, "profit": x["profit"]})
            elif not math.isfinite(current) or abs(target - current) >= cfg.pip_size(x["symbol"]) * 0.5:
                if abs(now_px - target) < spec["stops_level"] * spec["point"]:
                    rep["skipped"].append({"symbol": x["symbol"], "why": "new stop is closer than the broker allows; will try again next run"})
                    continue
                if not dry:
                    broker.modify_sl(x, target)
                rep["moved"].append({"symbol": x["symbol"], "side": side, "from": current, "to": target})
        except Exception as err:  # noqa: BLE001
            rep["skipped"].append({"symbol": x["symbol"], "why": f"couldn't update the stop: {err}"})

    # c) daily loss brake
    last_eq = a.get("last_equity") or 0
    braked = last_eq > 0 and equity < last_eq * (1 - L["daily_loss_pct"] / 100)
    a["last_equity"] = equity
    persist()

    # d) new entries
    wanted = [(sym, s) for sym, s in sig.items() if s and not s.get("error") and s.get("signal")]
    if ctx.get("paused") and wanted:
        rep["skipped"].append({"symbol": "—", "why": "paused (stops are still managed)"})
        return rep
    if braked and wanted:
        rep["skipped"].append({"symbol": "—", "why": f"equity fell more than {L['daily_loss_pct']}% since the last run, so no new trades today"})
        return rep
    day = bar_day(ctx["bar_time"])
    st.prune_did(a, day)

    for symbol, s in wanted:
        side = s["signal"]
        key = f"{day}:{symbol}"
        if len(mine) >= L["max_open"]:
            rep["skipped"].append({"symbol": symbol, "why": f"already {L['max_open']} positions open"})
            continue
        if any(x["symbol"] == symbol for x in mine):
            continue  # already in it (its stop is being trailed)
        exp = exposure([(x["symbol"], x["side"]) for x in mine] + [(symbol, side)])
        if any(n > L["max_per_currency"] for n in exp.values()):
            rep["skipped"].append({"symbol": symbol, "why": f"would put more than {L['max_per_currency']} trades on the same currency move"})
            continue
        if key in a["did"]:
            continue
        try:
            spec = broker.symbol_spec(symbol)
            if not spec["trade_full"]:
                rep["skipped"].append({"symbol": symbol, "why": "the broker doesn't allow opening trades on it right now"})
                continue
            q = broker.quote(symbol)
            entry = q["ask"] if side == "buy" else q["bid"]
            stop = initial_stop(fam, s["ind"], s["i"], side, p, entry)
            if stop is not None:
                stop = round(round_tick(stop, spec["tick_size"]), spec["digits"])
            if stop is None or not math.isfinite(stop) or (stop >= entry if side == "buy" else stop <= entry):
                rep["skipped"].append({"symbol": symbol, "why": "price already moved past the stop"})
                continue
            if abs(entry - stop) < spec["stops_level"] * spec["point"]:
                rep["skipped"].append({"symbol": symbol, "why": "the stop would be closer than the broker allows"})
                continue
            loss_per_lot = broker.loss_per_lot(symbol, side, entry, stop, spec)
            if not loss_per_lot > 0:
                rep["skipped"].append({"symbol": symbol, "why": "couldn't work out the risk per lot"})
                continue
            risk_money = equity * L["risk_pct"] / 100
            notional = broker.notional_per_lot(symbol, entry, spec)
            step = spec["volume_step"]
            volume = floor_step(risk_money / loss_per_lot, step)
            if notional > 0:
                volume = min(volume, floor_step(equity * L["max_leverage"] / L["max_open"] / notional, step))
            volume = min(volume, spec["max_volume"] or math.inf)
            min_vol = spec["min_volume"] or 0.01
            if volume < min_vol - 1e-12:
                needed = math.ceil(min_vol * loss_per_lot / (L["risk_pct"] / 100))
                rep["skipped"].append({"symbol": symbol, "why": f"account too small for this stop: the smallest trade ({min_vol} lot) "
                                                                f"would risk more than {L['risk_pct']}% (needs about {money(needed, acct['currency'])})"})
                continue
            volume = round(volume, step_decimals(step))
            a["did"][key] = 1
            persist()
            fill = entry
            if not dry:
                r = broker.open(symbol, side, volume, stop, spec)
                fill = r["price"]
                a["open"][str(r["ticket"])] = {"symbol": symbol, "side": side, "opened_at": st.now_iso(),
                                               "risk_money": volume * loss_per_lot, "entry": fill, "stop": stop}
                a["first_trade"] = a.get("first_trade") or st.now_iso()
                persist()
                mine.append({"symbol": symbol, "side": side, "id": str(r["ticket"])})
            else:
                mine.append({"symbol": symbol, "side": side, "id": f"dry-{symbol}"})
            rep["opened"].append({"symbol": symbol, "side": side, "volume": volume, "entry": fill, "stop": stop,
                                  "risk": volume * loss_per_lot, "why": why_text(strategy, symbol, side, s), "dry": dry})
        except Exception as err:  # noqa: BLE001
            a["did"].pop(key, None)
            persist()
            rep["skipped"].append({"symbol": symbol, "why": str(err)})
    return rep


def why_text(strategy, symbol, side, s):
    p = strategy["params"]
    c = s["candles"][s["i"]]
    fam = strategy["family"]
    if fam == "donchian":
        return (f"closed at {px(symbol, c['close'])}, above its highest price of the last {p['entryN']} days" if side == "buy"
                else f"closed at {px(symbol, c['close'])}, below its lowest price of the last {p['entryN']} days")
    if fam == "emaTrend":
        return (f"uptrend ({p['fast']}-day average above the {p['slow']}-day) and the price closed back above the {p['fast']}-day average" if side == "buy"
                else f"downtrend ({p['fast']}-day average below the {p['slow']}-day) and the price closed back below the {p['fast']}-day average")
    if fam == "tsmom":
        return (f"its {p['lookback']}-day change turned positive and it's above its 100-day average" if side == "buy"
                else f"its {p['lookback']}-day change turned negative and it's below its 100-day average")
    return strategy.get("label", "")


def report_lines(rep):
    lines = []
    ccy = rep["ccy"]
    for t in rep["stopped_out"]:
        if t["profit"] is None:
            res = "result not available yet"
        else:
            r = f" ({'+' if t['r'] > 0 else ''}{t['r']}R)" if t.get("r") is not None else ""
            res = f"{'✅' if t['profit'] >= 0 else '🔻'} {money(t['profit'], ccy)}{r}"
        lines.append(f"🔔 {t['symbol']} {side_word(t['side'])} closed at its stop: {res}")
    for t in rep["closed_now"]:
        lines.append(f"🔔 {t['symbol']} {side_word(t['side'])} closed: price was already past the new stop ({money(t['profit'], ccy)})")
    for t in rep["opened"]:
        lines.append(f"{'🧾 (dry run) would open' if t['dry'] else '🟢 Opened'} {t['symbol']} {side_word(t['side'])} {t['volume']} lot at ~{px(t['symbol'], t['entry'])}")
        lines.append(f"   Stop {px(t['symbol'], t['stop'])} on the broker's server · risk {money(t['risk'], ccy)} ({cfg.LIMITS['risk_pct']}% of equity)")
        lines.append(f"   Why: {t['why']}.")
    for t in rep["moved"]:
        frm = f"{px(t['symbol'], t['from'])} → " if math.isfinite(t["from"]) else "to "
        lines.append(f"↕️ {t['symbol']} stop moved {frm}{px(t['symbol'], t['to'])}")
    for t in rep["skipped"]:
        lines.append(f"⏭ {t['symbol']}: {t['why']}")
    return lines


# ─── The daily run ───────────────────────────────────────────────────────────
def wait_minutes():
    try:
        return float(os.environ.get("WAIT_AFTER_DAILY_OPEN_MIN", "60"))
    except ValueError:
        return 60.0


def run_daily(broker, force=False, dry=None, notify=True, log=print):
    dry = cfg.dry_run() if dry is None else dry
    with st.RunLock() as lock:
        if not lock.held:
            return {"skipped": "another run is in progress"}
        acct = broker.connect()
        s = st.load()
        a = st.account(s, acct)
        strategy = lab.active_strategy()
        sig = compute_signals(broker, strategy)
        bar_time = max([v["last_time"] for v in sig.values() if v.get("last_time")], default=0)
        if not bar_time:
            return {"skipped": "no price data", "errors": {k: v.get("error") for k, v in sig.items()}}
        if not force and bar_time <= (a.get("last_bar") or 0):
            return {"skipped": "no new daily candle yet"}

        # Right after the daily open (the broker's rollover) spreads are very
        # wide, so wait a while before trading the new candle.
        if not force:
            first_ok = next((k for k, v in sig.items() if not v.get("error")), None)
            age = broker.minutes_since_day_opened(first_ok) if first_ok else None
            if age is not None and 0 <= age < wait_minutes():
                return {"skipped": f"new candle is only {age:.0f} min old; waiting {wait_minutes():.0f} min after the daily open"}

        tag = "💵 REAL" if acct["live"] else "🧪 Demo"
        if acct["live"] and not s["flags"].get("live_unlocked"):
            a["last_bar"] = bar_time
            st.save(s)
            msg = (f"{tag} account {acct['login']} skipped: live trading is locked.\n"
                   "Run  python bot.py gate  to see what it still needs.")
            if notify:
                tg.send(msg, log)
            return {"skipped": "live trading is locked", "message": msg}

        if not dry:
            ok, why = broker.trading_allowed()
            if not ok:
                msg = f"⚠️ JijazyFX can't trade right now: {why}.\nOpen trades keep their stops on the broker's server. I'll try again next hour."
                if notify:
                    tg.send(msg, log)
                return {"skipped": why, "message": msg}

        ctx = {"paused": s["flags"].get("paused"), "bar_time": bar_time}
        rep = manage(broker, a, acct, sig, strategy, ctx, dry=dry, persist=lambda: st.save(s))
        a["last_bar"] = bar_time
        st.save(s)

        signals = [f"{k} {v['signal'].upper()}" for k, v in sig.items() if v.get("signal")]
        errors = [f"{k}: {v['error']}" for k, v in sig.items() if v.get("error")]
        head = [f"{tag} · JijazyFX daily run · candle of {bar_day(bar_time)}",
                f"Strategy: {strategy['label']} ({strategy['verdict']})",
                f"Signals: {', '.join(signals) or 'none'}"]
        body = report_lines(rep)
        tail = [f"⚠️ Price errors: {'; '.join(errors)}"] if errors else []
        if ctx["paused"]:
            tail.append("⏸ Paused: no new trades, stops still managed.")
        tail.append(f"Equity: {money(rep['equity'], rep['ccy'])}")
        msg = "\n".join(head + ([""] + body if body else []) + [""] + tail)
        if notify:
            tg.send(msg, log)
        return {"bar_date": bar_day(bar_time), "opened": len(rep["opened"]), "moved": len(rep["moved"]),
                "closed": len(rep["stopped_out"]) + len(rep["closed_now"]), "message": msg}


def close_bot_positions(broker, symbol=None, dry=None):
    dry = cfg.dry_run() if dry is None else dry
    acct = broker.connect()
    s = st.load()
    a = st.account(s, acct)
    done = []
    for x in broker.positions():
        if symbol and x["symbol"].upper() != symbol.upper():
            continue
        if not dry:
            broker.close_position(x, broker.symbol_spec(x["symbol"]))
            record_closed(broker, a, x["id"], {**a["open"].get(x["id"], {}), "symbol": x["symbol"], "side": x["side"]},
                          fallback_profit=x["profit"])
            st.save(s)
        done.append(x)
    return done
