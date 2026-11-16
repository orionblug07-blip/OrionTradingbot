"""
JijazyFX (local edition): run from a Command Prompt in this folder.

  python bot.py run            the daily check (Task Scheduler runs this every hour)
  python bot.py run --force    run it now even if today's candle was already handled
  python bot.py run --dry-run  show what it would do, without sending orders
  python bot.py status         account, balance, strategy, pause/live flags
  python bot.py positions      the bot's open trades
  python bot.py signals        today's signals (no trading)
  python bot.py results        how the bot's closed trades went
  python bot.py lab            test the strategies on ~10 years of prices
  python bot.py gate           what real-money trading still needs
  python bot.py close EURUSD   close the bot's EURUSD trade now   (or: close all)
  python bot.py pause          no new trades (stops are still managed)
  python bot.py resume
  python bot.py unlock-live    allow a REAL account to trade (only after the gate passes)
  python bot.py lock-live
  python bot.py telegram-test  send a test message
"""
import sys
import traceback
from datetime import datetime

from jijazy import config as cfg

cfg.load_env()

from jijazy import lab, state as st, telegram as tg, trader  # noqa: E402
from jijazy.broker import Broker  # noqa: E402


def log(msg):
    print(msg)
    try:
        cfg.DATA_DIR.mkdir(parents=True, exist_ok=True)
        with open(cfg.LOG_FILE, "a", encoding="utf-8") as f:
            f.write(f"[{datetime.now().isoformat(timespec='seconds')}] {msg}\n")
    except OSError:
        pass


def cmd_run(args):
    b = Broker()
    try:
        out = trader.run_daily(b, force="--force" in args, dry=True if "--dry-run" in args else None, log=log)
    finally:
        b.close()
    log(out.get("message") or f"run: {out}")


def cmd_status(args):
    b = Broker()
    try:
        acct = b.connect()
        ok, why = b.trading_allowed()
        mine = b.positions()
    finally:
        b.close()
    s = st.load()
    strat = lab.active_strategy()
    print(f"Account {acct['login']} on {acct['server']} ({acct['mode'].upper()})")
    print(f"Balance {trader.money(acct['balance'], acct['currency'])} · equity {trader.money(acct['equity'], acct['currency'])} · leverage 1:{acct['leverage']}")
    print(f"Bot positions open: {len(mine)}")
    print(f"Trading allowed: {'yes' if ok else 'NO, ' + why}")
    print(f"Strategy: {strat['label']} ({strat['verdict']})")
    print(f"Paused: {'yes' if s['flags'].get('paused') else 'no'} · live trading unlocked: {'yes' if s['flags'].get('live_unlocked') else 'no'}")
    print(f"Dry run: {'yes' if cfg.dry_run() else 'no'} · Telegram: {'set' if tg.configured() else 'not set'}")


def cmd_positions(args):
    b = Broker()
    try:
        acct = b.connect()
        mine = b.positions()
    finally:
        b.close()
    if not mine:
        print("No open bot trades.")
    for x in mine:
        print(f"{x['symbol']} {trader.side_word(x['side'])} {x['volume']} lot @ {trader.px(x['symbol'], x['open_price'])} · "
              f"now {trader.px(x['symbol'], x['current_price'])} · stop {trader.px(x['symbol'], x['sl'])} · "
              f"P/L {trader.money(x['profit'], acct['currency'])}")


def cmd_signals(args):
    b = Broker()
    try:
        b.connect()
        strat = lab.active_strategy()
        sig = trader.compute_signals(b, strat)
    finally:
        b.close()
    print(f"Strategy: {strat['label']} ({strat['verdict']})")
    for k, v in sig.items():
        if v.get("error"):
            print(f"{k}: ⚠️ {v['error']}")
        else:
            print(f"{k}: {v['signal'].upper() if v['signal'] else 'no signal'} (close {trader.px(k, v['close'])} on {trader.bar_day(v['last_time'])})")


def cmd_results(args):
    s = st.load()
    if not s["accounts"]:
        print("No trades yet.")
    for login, a in s["accounts"].items():
        f = st.forward_stats(a)
        print(f"Account {login} ({a.get('mode')}): {f['closed']} closed trades, {f['wins']} wins, profit {f['profit']}, "
              f"avg {f['avg_r']}R, running {f['days']} days")
        for t in a.get("closed", [])[:10]:
            print(f"   {t['closed_at'][:10]} {t['symbol']} {trader.side_word(t['side'])}: {t['profit']} ({t['r']}R)")


def cmd_lab(args):
    b = Broker()
    try:
        b.connect()
        log("🧪 Lab: downloading prices…")
        data = lab.load_data(b, log=log)
    finally:
        b.close()
    result = lab.run_lab(data)
    lab.save_result(result)
    text = lab.summary(result)
    log(text)
    tg.send(text, log)


def cmd_gate(args):
    g = trader.live_gate(st.load())
    f = g["forward"]
    print(f"Strategy: {g['strategy']['label']} ({g['strategy']['verdict']})")
    print(f"Demo forward test: {f['days']} days, {f['closed']} closed trades, profit {f['profit']}")
    print("✅ All conditions met: `python bot.py unlock-live` is available." if g["ok"]
          else "Still needed:\n" + "\n".join(f"• {r}" for r in g["reasons"]))


def cmd_close(args):
    if not args:
        print("Say which: python bot.py close EURUSD   or   python bot.py close all")
        return
    target = None if args[0].lower() == "all" else args[0]
    b = Broker()
    try:
        done = trader.close_bot_positions(b, target)
    finally:
        b.close()
    if not done:
        print("No matching bot trades.")
    for x in done:
        log(f"Closed {x['symbol']} {trader.side_word(x['side'])} ({x['profit']:.2f})")


def set_flag(name, on, msg):
    s = st.load()
    s["flags"][name] = on
    st.save(s)
    log(msg)


def cmd_unlock(args):
    g = trader.live_gate(st.load())
    if not g["ok"]:
        print("🔒 Can't unlock yet:\n" + "\n".join(f"• {r}" for r in g["reasons"]))
        return
    print("⚠️ This lets the bot trade a REAL-money account. Forex with leverage can lose money quickly, and past results are not a promise.")
    typed = input(f'Type exactly "{cfg.LIVE_CONFIRM}" to continue: ')
    if typed.strip() != cfg.LIVE_CONFIRM:
        print("Not unlocked.")
        return
    set_flag("live_unlocked", True, "🔓 Live trading unlocked.")


COMMANDS = {
    "run": cmd_run, "status": cmd_status, "positions": cmd_positions, "signals": cmd_signals,
    "results": cmd_results, "lab": cmd_lab, "gate": cmd_gate, "close": cmd_close,
    "pause": lambda a: set_flag("paused", True, "⏸ Paused. No new trades; open trades keep their stops and still get trailed."),
    "resume": lambda a: set_flag("paused", False, "▶️ Resumed. New trades allowed from the next daily run."),
    "unlock-live": cmd_unlock,
    "lock-live": lambda a: set_flag("live_unlocked", False, "🔒 Live trading locked."),
    "telegram-test": lambda a: print("Sent ✅" if tg.send("👋 JijazyFX (local) can reach you on Telegram.") else "Couldn't send. Check TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env"),
}


def main(argv):
    if not argv or argv[0] not in COMMANDS:
        print(__doc__)
        return 0 if not argv else 1
    try:
        COMMANDS[argv[0]](argv[1:])
        return 0
    except Exception as err:  # noqa: BLE001
        log(f"❌ {argv[0]} failed: {err}")
        if argv[0] == "run":
            # At most one failure alert every 6 hours, so an hourly task doesn't spam you
            s = st.load()
            last = s["flags"].get("last_error_alert", 0)
            if datetime.now().timestamp() - last > 6 * 3600:
                tg.send(f"❌ JijazyFX run failed: {err}\nOpen trades keep their stops on the broker's server.", log)
                s["flags"]["last_error_alert"] = datetime.now().timestamp()
                st.save(s)
        if "--debug" in argv:
            traceback.print_exc()
        return 1


if __name__ == "__main__":
    # Windows consoles may not handle emoji by default
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass
    sys.exit(main(sys.argv[1:]))
