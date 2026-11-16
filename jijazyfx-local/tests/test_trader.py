"""Offline tests: python -m unittest discover -s tests"""
import math
import os
import random
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from jijazy import broker as broker_mod, config as cfg, lab, state as st, trader  # noqa: E402
from jijazy.broker import Broker  # noqa: E402
import fake_mt5  # noqa: E402

T0 = 1735689600  # 2025-01-01


def flat(start, n=300, seed=1, vol=0.001):
    r = random.Random(seed)
    out, px, t = [], start, T0
    for _ in range(n):
        o = px
        c = start * (1 + r.uniform(-vol, vol))
        out.append({"time": t, "open": o, "high": max(o, c) * (1 + vol / 4), "low": min(o, c) * (1 - vol / 4), "close": c, "spread": 10})
        px, t = c, t + 86400
    return out


def breakout(candles, up=True, size=0.01):
    """Append a bar that closes beyond the 55-day range."""
    last = candles[-1]
    hi = max(c["high"] for c in candles[-55:])
    lo = min(c["low"] for c in candles[-55:])
    close = hi * (1 + size) if up else lo * (1 - size)
    o = last["close"]
    candles.append({"time": last["time"] + 86400, "open": o, "high": max(o, close) * 1.0005, "low": min(o, close) * 0.9995, "close": close, "spread": 10})
    return candles


def add_bar(candles, close, high=None, low=None):
    last = candles[-1]
    o = last["close"]
    candles.append({"time": last["time"] + 86400, "open": o, "high": high or max(o, close), "low": low or min(o, close), "close": close, "spread": 10})


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        d = Path(self.tmp.name)
        self._saved = (cfg.DATA_DIR, cfg.STATE_FILE, cfg.STRATEGY_FILE, cfg.LOCK_FILE, cfg.LOG_FILE, broker_mod.mt5)
        cfg.DATA_DIR, cfg.STATE_FILE, cfg.STRATEGY_FILE, cfg.LOCK_FILE, cfg.LOG_FILE = d, d / "state.json", d / "s.json", d / "run.lock", d / "log"
        os.environ.pop("TELEGRAM_BOT_TOKEN", None)
        os.environ.pop("AUTOTRADE_DRY_RUN", None)
        os.environ["FX_SYMBOLS"] = "EURUSD,GBPUSD,USDJPY"
        self.candles = {"EURUSD": flat(1.10, seed=1), "GBPUSD": flat(1.27, seed=2), "USDJPY": flat(150.0, seed=3)}

    def tearDown(self):
        cfg.DATA_DIR, cfg.STATE_FILE, cfg.STRATEGY_FILE, cfg.LOCK_FILE, cfg.LOG_FILE, broker_mod.mt5 = self._saved
        os.environ.pop("FX_SYMBOLS", None)
        self.tmp.cleanup()

    def fake(self, **kw):
        self.mt = fake_mt5.Fake(self.candles, **kw)
        broker_mod.mt5 = self.mt
        return self.mt

    def run_daily(self, **kw):
        kw.setdefault("notify", False)
        return trader.run_daily(Broker(), log=lambda m: None, **kw)

    def deals(self):
        return [r for r in self.mt.sent if r["action"] == fake_mt5.TRADE_ACTION_DEAL and "position" not in r]


class TestEntries(Base):
    def test_breakout_opens_with_server_stop_and_1pct_risk(self):
        breakout(self.candles["EURUSD"])
        mt = self.fake()
        out = self.run_daily()
        self.assertEqual(out["opened"], 1)
        req = self.deals()[0]
        self.assertEqual(req["symbol"], "EURUSD")
        self.assertEqual(req["type"], fake_mt5.ORDER_TYPE_BUY)
        self.assertEqual(req["magic"], cfg.MAGIC)
        self.assertLess(req["sl"], req["price"])
        risk = (req["price"] - req["sl"]) * 100000 * req["volume"]
        self.assertLessEqual(risk, 100.0 + 1e-6)          # never more than 1% of $10,000
        self.assertGreater(risk, 100.0 - 1000 * (req["price"] - req["sl"]))  # within one volume step
        self.assertIn("EURUSD BUY", out["message"])
        self.assertIn("Why:", out["message"])
        s = st.load()
        a = s["accounts"]["12345"]
        self.assertEqual(len(a["open"]), 1)
        self.assertIsNotNone(a["first_trade"])
        self.assertEqual(len(mt.positions), 1)

    def test_runs_once_per_candle_and_never_doubles_up(self):
        breakout(self.candles["EURUSD"])
        self.fake()
        self.run_daily()
        self.assertEqual(self.run_daily(), {"skipped": "no new daily candle yet"})
        self.run_daily(force=True)
        self.assertEqual(len(self.deals()), 1)

    def test_short_breakout_sells(self):
        breakout(self.candles["GBPUSD"], up=False)
        self.fake()
        self.run_daily()
        req = self.deals()[0]
        self.assertEqual(req["type"], fake_mt5.ORDER_TYPE_SELL)
        self.assertGreater(req["sl"], req["price"])

    def test_waits_after_the_daily_open(self):
        breakout(self.candles["EURUSD"])
        mt = self.fake()
        mt.today_age_min = 10
        out = self.run_daily()
        self.assertIn("waiting", out["skipped"])
        self.assertEqual(self.deals(), [])
        mt.today_age_min = 90
        self.assertEqual(self.run_daily()["opened"], 1)

    def test_dry_run_sends_nothing(self):
        breakout(self.candles["EURUSD"])
        self.fake()
        out = self.run_daily(dry=True)
        self.assertEqual(self.mt.sent, [])
        self.assertIn("dry run", out["message"])

    def test_paused_opens_nothing(self):
        breakout(self.candles["EURUSD"])
        self.fake()
        s = st.load(); s["flags"]["paused"] = True; st.save(s)
        out = self.run_daily()
        self.assertEqual(self.deals(), [])
        self.assertIn("paused", out["message"].lower())

    def test_real_account_locked_until_unlocked(self):
        breakout(self.candles["EURUSD"])
        self.fake(mode=fake_mt5.ACCOUNT_TRADE_MODE_REAL)
        out = self.run_daily()
        self.assertEqual(out["skipped"], "live trading is locked")
        self.assertEqual(self.mt.sent, [])

    def test_algo_trading_off_retries_next_hour(self):
        breakout(self.candles["EURUSD"])
        mt = self.fake(algo=False)
        out = self.run_daily()
        self.assertIn("Algo Trading", out["skipped"])
        mt.algo = True
        self.assertEqual(self.run_daily()["opened"], 1)  # candle not marked as handled

    def test_currency_limit(self):
        # three trades all short USD: EURUSD buy, GBPUSD buy, USDJPY sell -> only 2 allowed
        breakout(self.candles["EURUSD"]); breakout(self.candles["GBPUSD"]); breakout(self.candles["USDJPY"], up=False)
        self.fake()
        out = self.run_daily()
        self.assertEqual(out["opened"], 2)
        self.assertIn("same currency move", out["message"])

    def test_daily_loss_brake(self):
        self.fake()
        self.run_daily()                     # stores equity 10,000
        breakout(self.candles["EURUSD"])
        self.mt.equity = 9600                # -4%
        out = self.run_daily()
        self.assertEqual(self.deals(), [])
        self.assertIn("equity fell", out["message"])

    def test_small_account_is_refused_not_overrisked(self):
        breakout(self.candles["EURUSD"], size=0.02)
        self.fake(equity=20)
        out = self.run_daily()
        self.assertEqual(self.deals(), [])
        self.assertIn("account too small", out["message"])


class TestManagingTrades(Base):
    def test_stop_tightens_then_stop_out_is_reported(self):
        breakout(self.candles["EURUSD"])
        mt = self.fake()
        self.run_daily()
        pos = mt.positions[0]
        first_sl = pos.sl
        # price keeps rising for 25 days -> the 20-day low rises -> stop moves up
        c = self.candles["EURUSD"]
        for k in range(25):
            add_bar(c, c[-1]["close"] * 1.004)
            pos.price_current = c[-1]["close"]
            self.run_daily()
        self.assertGreater(pos.sl, first_sl)
        mods = [r for r in mt.sent if r["action"] == fake_mt5.TRADE_ACTION_SLTP]
        self.assertTrue(mods)
        self.assertTrue(all(b["sl"] >= a["sl"] for a, b in zip(mods, mods[1:])))  # never loosened
        # the broker closes it at the stop
        mt.positions = []
        mt.deals[pos.ticket] = [fake_mt5.NS(profit=150.0, commission=0.0, swap=0.0, fee=0.0)]
        add_bar(c, c[-1]["close"])
        out = self.run_daily()
        self.assertIn("closed at its stop", out["message"])
        a = st.load()["accounts"]["12345"]
        self.assertEqual(a["closed"][0]["profit"], 150.0)
        self.assertAlmostEqual(a["closed"][0]["r"], 1.5, delta=0.1)
        self.assertEqual(st.forward_stats(a)["closed"], 1)

    def test_never_touches_manual_trades(self):
        mt = self.fake()
        mt.positions.append(fake_mt5.NS(ticket=1, magic=0, symbol="EURUSD", type=0, volume=1.0, price_open=1.0,
                                        price_current=1.2, sl=0.0, tp=0.0, profit=0.0, time=T0))
        self.run_daily()
        self.assertEqual(Broker().positions(), [])
        self.assertEqual(mt.sent, [])

    def test_close_all(self):
        breakout(self.candles["EURUSD"])
        mt = self.fake()
        self.run_daily()
        done = trader.close_bot_positions(Broker())
        self.assertEqual(len(done), 1)
        self.assertEqual(mt.positions, [])
        self.assertEqual(len(st.load()["accounts"]["12345"]["closed"]), 1)


class TestGateAndLab(Base):
    def test_gate_needs_pass_and_forward_test(self):
        g = trader.live_gate(st.load())
        self.assertFalse(g["ok"])
        self.assertTrue(any("PASS" in r for r in g["reasons"]))

    def test_lab_runs_and_feeds_the_trader(self):
        r = random.Random(7)
        data = {}
        for s, start in (("EURUSD", 1.1), ("GBPUSD", 1.3)):
            c, px, t, drift = [], start, T0, 0
            for i in range(1500):
                if i % 150 == 0:
                    drift = r.uniform(-0.002, 0.002)
                o = px; cl = o * (1 + drift + r.gauss(0, 0.005))
                c.append({"time": t, "open": o, "high": max(o, cl) * 1.002, "low": min(o, cl) * 0.998, "close": cl, "spread": 8})
                px, t = cl, t + 86400
            data[s] = {"candles": c, "cost": lab.cost_for(s, c, 0.00001)}
        res = lab.run_lab(data)
        self.assertEqual(len(res["families"]), 3)
        lab.save_result(res)
        self.assertEqual(lab.active_strategy()["id"], res["chosen"]["id"])
        self.assertIn("Strategy lab", lab.summary(res))

    def test_cost_floor(self):
        c = [{"spread": 1}] * 10
        self.assertAlmostEqual(lab.cost_for("EURUSD", c, 0.00001), 1.2 * 0.0001)
        c = [{"spread": 50}] * 10
        self.assertAlmostEqual(lab.cost_for("EURUSD", c, 0.00001), 50 * 0.00001 + 0.4 * 0.0001)


if __name__ == "__main__":
    unittest.main()
