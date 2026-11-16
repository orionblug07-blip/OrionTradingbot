"""
The only file that talks to MetaTrader 5, through MetaQuotes' official
`MetaTrader5` Python package. It drives the MT5 terminal installed on this
Windows PC, so no cloud service (and no MetaApi bill) is needed.

Tests swap `mt5` for a fake (see tests/fake_mt5.py).
"""
import os
import time

try:
    import MetaTrader5 as mt5  # Windows only
except ImportError:  # lets the lab/backtest and the tests run anywhere
    mt5 = None

from . import config as cfg

OK_CODES = {10008, 10009, 10010}  # placed / done / partially done
DEVIATION = 20                    # max slippage in points for market orders


class BrokerError(Exception):
    pass


def _need():
    if mt5 is None:
        raise BrokerError("The MetaTrader5 package isn't installed. Run:  pip install MetaTrader5  (Windows only)")


def _err(what):
    code, msg = mt5.last_error()
    return BrokerError(f"{what}: {msg} ({code})")


class Broker:
    def __init__(self):
        self.connected = False

    # ─── Connection ──────────────────────────────────────────────────────────
    def connect(self):
        """Start (or attach to) the MT5 terminal and log in if MT5_LOGIN is set."""
        _need()
        kwargs = {}
        path = os.environ.get("MT5_PATH", "").strip()
        login = os.environ.get("MT5_LOGIN", "").strip()
        if login:
            kwargs.update(login=int(login), password=os.environ.get("MT5_PASSWORD", ""), server=os.environ.get("MT5_SERVER", ""))
        ok = mt5.initialize(path, **kwargs) if path else mt5.initialize(**kwargs)
        if not ok:
            raise _err("Couldn't start or log in to MetaTrader 5 (check MT5_PATH, MT5_LOGIN, MT5_PASSWORD, MT5_SERVER)")
        self.connected = True
        return self.account()

    def close(self):
        if mt5 is not None and self.connected:
            mt5.shutdown()
            self.connected = False

    def trading_allowed(self):
        """(ok, reason). Python orders need the terminal's 'Algo Trading' button ON."""
        term = mt5.terminal_info()
        if term is None:
            return False, "MT5 terminal not available"
        if not term.trade_allowed:
            return False, "the 'Algo Trading' button in MetaTrader 5 is off. Click it so it turns green"
        acc = mt5.account_info()
        if acc is None or not acc.trade_allowed:
            return False, "the broker doesn't allow trading on this account right now"
        return True, ""

    # ─── Account ─────────────────────────────────────────────────────────────
    def account(self):
        a = mt5.account_info()
        if a is None:
            raise _err("Couldn't read the account")
        mode = {mt5.ACCOUNT_TRADE_MODE_DEMO: "demo", mt5.ACCOUNT_TRADE_MODE_CONTEST: "contest"}.get(a.trade_mode, "real")
        return {"login": str(a.login), "server": a.server, "currency": a.currency or "USD", "balance": float(a.balance),
                "equity": float(a.equity), "leverage": a.leverage, "mode": mode, "live": mode == "real", "name": a.name}

    def positions(self):
        """The bot's open positions only (magic number), as dicts."""
        rows = mt5.positions_get()
        if rows is None:
            raise _err("Couldn't read positions")
        out = []
        for p in rows:
            if int(p.magic) != cfg.MAGIC:
                continue
            out.append({"id": str(p.ticket), "ticket": int(p.ticket), "symbol": p.symbol,
                        "side": "buy" if p.type == mt5.POSITION_TYPE_BUY else "sell",
                        "volume": float(p.volume), "open_price": float(p.price_open), "current_price": float(p.price_current),
                        "sl": float(p.sl) or None, "tp": float(p.tp) or None, "profit": float(p.profit), "time": int(p.time)})
        return out

    def position_result(self, ticket):
        """Money result of a closed position (profit + commission + swap + fee), or None."""
        deals = mt5.history_deals_get(position=int(ticket))
        if not deals:
            return None
        return sum(float(d.profit) + float(d.commission) + float(d.swap) + float(getattr(d, "fee", 0) or 0) for d in deals)

    # ─── Market data ─────────────────────────────────────────────────────────
    def _select(self, symbol):
        if not mt5.symbol_select(symbol, True):
            raise _err(f"{symbol} isn't available at your broker (check the name in Market Watch)")

    def closed_daily_candles(self, symbol, bars):
        """Up to `bars` CLOSED daily candles, oldest first. Position 0 is today's
        forming candle, so we start at position 1."""
        self._select(symbol)
        rates = None
        for _ in range(3):  # the terminal may still be downloading history
            rates = mt5.copy_rates_from_pos(symbol, mt5.TIMEFRAME_D1, 1, int(bars))
            if rates is not None and len(rates) > 0:
                break
            time.sleep(2)
        if rates is None or len(rates) == 0:
            raise _err(f"No daily prices for {symbol}")
        return [{"time": int(r["time"]), "open": float(r["open"]), "high": float(r["high"]), "low": float(r["low"]),
                 "close": float(r["close"]), "spread": int(r["spread"])} for r in rates]

    def minutes_since_day_opened(self, symbol):
        """How long today's daily candle has been open (server clock), or None."""
        self._select(symbol)
        today = mt5.copy_rates_from_pos(symbol, mt5.TIMEFRAME_D1, 0, 1)
        tick = mt5.symbol_info_tick(symbol)
        if today is None or len(today) == 0 or tick is None:
            return None
        return (int(tick.time) - int(today[0]["time"])) / 60

    def symbol_spec(self, symbol):
        self._select(symbol)
        s = mt5.symbol_info(symbol)
        if s is None:
            raise _err(f"No details for {symbol}")
        return {"point": float(s.point), "digits": int(s.digits), "tick_size": float(s.trade_tick_size) or float(s.point),
                "tick_value": float(s.trade_tick_value_loss or s.trade_tick_value), "min_volume": float(s.volume_min),
                "max_volume": float(s.volume_max), "volume_step": float(s.volume_step) or 0.01,
                "trade_full": s.trade_mode == mt5.SYMBOL_TRADE_MODE_FULL, "stops_level": int(s.trade_stops_level),
                "filling_mode": int(s.filling_mode)}

    def quote(self, symbol):
        t = mt5.symbol_info_tick(symbol)
        if t is None or not t.bid:
            raise _err(f"No live price for {symbol}")
        return {"bid": float(t.bid), "ask": float(t.ask), "time": int(t.time)}

    def loss_per_lot(self, symbol, side, entry, stop, spec):
        """Money lost (account currency) if 1 lot hits the stop."""
        typ = mt5.ORDER_TYPE_BUY if side == "buy" else mt5.ORDER_TYPE_SELL
        v = mt5.order_calc_profit(typ, symbol, 1.0, entry, stop)
        if v is not None and v < 0:
            return abs(float(v))
        return abs(entry - stop) / spec["tick_size"] * spec["tick_value"]

    def notional_per_lot(self, symbol, entry, spec):
        """Value of 1 lot in account currency (what a 100% move would pay)."""
        v = mt5.order_calc_profit(mt5.ORDER_TYPE_BUY, symbol, 1.0, entry, entry * 2)
        if v is not None and v > 0:
            return float(v)
        return entry * spec["tick_value"] / spec["tick_size"]

    # ─── Trading ─────────────────────────────────────────────────────────────
    def _filling(self, spec):
        fm = spec.get("filling_mode", 0)
        if fm & 1:
            return mt5.ORDER_FILLING_FOK
        if fm & 2:
            return mt5.ORDER_FILLING_IOC
        return mt5.ORDER_FILLING_RETURN

    def _send(self, req, what):
        r = mt5.order_send(req)
        if r is None:
            raise _err(f"{what} failed")
        if r.retcode not in OK_CODES:
            hint = " (turn on 'Algo Trading' in MT5)" if r.retcode == 10027 else ""
            raise BrokerError(f"{what} rejected: {r.comment} ({r.retcode}){hint}")
        return r

    def open(self, symbol, side, volume, sl, spec):
        q = self.quote(symbol)
        req = {"action": mt5.TRADE_ACTION_DEAL, "symbol": symbol, "volume": float(volume),
               "type": mt5.ORDER_TYPE_BUY if side == "buy" else mt5.ORDER_TYPE_SELL,
               "price": q["ask"] if side == "buy" else q["bid"], "sl": float(sl), "deviation": DEVIATION,
               "magic": cfg.MAGIC, "comment": cfg.COMMENT, "type_time": mt5.ORDER_TIME_GTC, "type_filling": self._filling(spec)}
        r = self._send(req, f"{symbol} {side} order")
        # In MT5 the new position's ticket is the ticket of the order that opened it.
        return {"ticket": int(r.order), "price": float(r.price or req["price"])}

    def modify_sl(self, pos, sl):
        req = {"action": mt5.TRADE_ACTION_SLTP, "position": pos["ticket"], "symbol": pos["symbol"], "sl": float(sl),
               "tp": float(pos.get("tp") or 0.0), "magic": cfg.MAGIC}
        self._send(req, f"{pos['symbol']} stop update")

    def close_position(self, pos, spec):
        q = self.quote(pos["symbol"])
        buy = pos["side"] == "buy"
        req = {"action": mt5.TRADE_ACTION_DEAL, "symbol": pos["symbol"], "volume": pos["volume"], "position": pos["ticket"],
               "type": mt5.ORDER_TYPE_SELL if buy else mt5.ORDER_TYPE_BUY, "price": q["bid"] if buy else q["ask"],
               "deviation": DEVIATION, "magic": cfg.MAGIC, "comment": cfg.COMMENT, "type_time": mt5.ORDER_TIME_GTC,
               "type_filling": self._filling(spec)}
        self._send(req, f"{pos['symbol']} close")
