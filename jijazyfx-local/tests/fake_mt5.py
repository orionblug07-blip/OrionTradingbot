"""A pretend MetaTrader5 module + broker, so the trader can be tested anywhere."""
from types import SimpleNamespace as NS

ACCOUNT_TRADE_MODE_DEMO, ACCOUNT_TRADE_MODE_CONTEST, ACCOUNT_TRADE_MODE_REAL = 0, 1, 2
POSITION_TYPE_BUY, POSITION_TYPE_SELL = 0, 1
ORDER_TYPE_BUY, ORDER_TYPE_SELL = 0, 1
TRADE_ACTION_DEAL, TRADE_ACTION_SLTP = 1, 6
ORDER_TIME_GTC = 0
ORDER_FILLING_FOK, ORDER_FILLING_IOC, ORDER_FILLING_RETURN = 0, 1, 2
SYMBOL_TRADE_MODE_FULL = 4
TIMEFRAME_D1 = 16408


class Fake:
    def __init__(self, candles, equity=10000.0, mode=ACCOUNT_TRADE_MODE_DEMO, algo=True):
        self.candles = candles          # {symbol: [closed candles]}
        self.equity = equity
        self.mode = mode
        self.algo = algo
        self.positions = []
        self.deals = {}
        self.sent = []
        self.next_ticket = 1000
        self.today_age_min = 120

    # module-level API ---------------------------------------------------------
    def initialize(self, *a, **k): return True
    def shutdown(self): pass
    def last_error(self): return (1, "fake error")
    def terminal_info(self): return NS(trade_allowed=self.algo)
    def account_info(self):
        return NS(login=12345, server="OctaFX-Demo", currency="USD", balance=self.equity, equity=self.equity,
                  leverage=500, trade_mode=self.mode, trade_allowed=True, name="Test")
    def positions_get(self): return list(self.positions)
    def history_deals_get(self, position=None): return self.deals.get(position, [])
    def symbol_select(self, s, on): return s in self.candles

    def copy_rates_from_pos(self, symbol, tf, start, count):
        c = self.candles[symbol]
        if start == 0:  # today's forming candle
            last = c[-1]
            return [{"time": last["time"] + 86400, "open": last["close"], "high": last["close"], "low": last["close"], "close": last["close"], "spread": 10}]
        return c[-count:]

    def _pip(self, s): return 0.01 if "JPY" in s else 0.0001

    def symbol_info(self, s):
        jpy = "JPY" in s
        return NS(point=0.001 if jpy else 0.00001, digits=3 if jpy else 5, trade_tick_size=0.001 if jpy else 0.00001,
                  trade_tick_value=0.67 if jpy else 1.0, trade_tick_value_loss=0.67 if jpy else 1.0,
                  volume_min=0.01, volume_max=100.0, volume_step=0.01, trade_mode=SYMBOL_TRADE_MODE_FULL,
                  trade_stops_level=0, filling_mode=1)

    def symbol_info_tick(self, s):
        last = self.candles[s][-1]
        sp = 2 * self._pip(s) / 10
        return NS(bid=last["close"], ask=last["close"] + sp, time=last["time"] + 86400 + int(self.today_age_min * 60))

    def order_calc_profit(self, typ, s, vol, a, b):
        contract = 100000
        diff = (b - a) if typ == ORDER_TYPE_BUY else (a - b)
        v = diff * contract * vol
        return v / b if "JPY" in s or s.startswith("USD") else v

    def order_send(self, req):
        self.sent.append(req)
        if req["action"] == TRADE_ACTION_DEAL and "position" not in req:
            self.next_ticket += 1
            t = self.next_ticket
            self.positions.append(NS(ticket=t, magic=req["magic"], symbol=req["symbol"],
                                     type=POSITION_TYPE_BUY if req["type"] == ORDER_TYPE_BUY else POSITION_TYPE_SELL,
                                     volume=req["volume"], price_open=req["price"], price_current=req["price"],
                                     sl=req["sl"], tp=0.0, profit=0.0, time=self.candles[req["symbol"]][-1]["time"] + 86400))
            return NS(retcode=10009, order=t, price=req["price"], comment="done")
        if req["action"] == TRADE_ACTION_DEAL:  # close
            self.positions = [p for p in self.positions if p.ticket != req["position"]]
            return NS(retcode=10009, order=0, price=req["price"], comment="done")
        if req["action"] == TRADE_ACTION_SLTP:
            for p in self.positions:
                if p.ticket == req["position"]:
                    p.sl = req["sl"]
            return NS(retcode=10009, order=0, price=0, comment="done")
        return NS(retcode=10013, order=0, price=0, comment="invalid")

    def __getattr__(self, name):  # constants
        return globals()[name]
