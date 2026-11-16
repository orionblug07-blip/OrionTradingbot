# JijazyFX: local edition (free, no MetaApi)

The same forex bot as before, with the same strategies, the same 1% risk per trade, the same safety limits and the same Telegram reports. The difference is that it now runs on **your own Windows PC** and talks to the **MT5 terminal** directly, through MetaQuotes' free official `MetaTrader5` Python package. No MetaApi, no Vercel, no Redis, no monthly bill.

**How it works:** a Windows scheduled task runs `python bot.py run` every hour. The bot only acts once per new daily candle, and it waits about an hour after the candle opens so it doesn't trade through the broker's wide rollover spreads. On that run it:
- reports trades that hit their stop
- tightens open stops (never loosens them)
- opens new trades for today's signals, with the stop sent **in the same order**, so it sits on Octa's server

**Your PC doesn't need to be on all the time.** The stops live on the broker's server, so open trades stay protected while the laptop is off. If the PC is off when a new candle arrives, the bot handles it the next time it wakes up. The trade then opens later than the backtest assumes (the backtest uses the daily open), so try to keep the laptop on, plugged in and not asleep around the daily close. For Octa that's usually close to midnight, Lagos time. Check the open time of the D1 candles in MT5.

**What's different from the Telegram version:**
- It manages **one account**: the one logged in to your MT5 terminal. Other people can't connect their own accounts.
- Telegram is **send-only**. You get every report and alert, but you give commands on the PC (`python bot.py …`) instead of in the chat.

---

## Setup (one time, about 20 minutes)

### 1. MetaTrader 5
1. Install **Octa's MetaTrader 5** for Windows (from your Octa account area), and log in to your **demo** account. Tick **Save password**.
2. Click the **Algo Trading** button on the toolbar so it turns **green**. Without this, MT5 refuses orders from Python.
3. In **Market Watch**, right-click and choose **Show All**, so every symbol is available.

### 2. Python
1. Install **Python 3.12 (64-bit)** from python.org. On the first screen, tick **"Add python.exe to PATH"**.
2. Unzip this folder somewhere simple, e.g. `C:\JijazyFX`.
3. Open **Command Prompt** in that folder (type `cmd` in the File Explorer address bar and press Enter), then run:
   ```
   pip install -r requirements.txt
   ```

### 3. Settings
1. Copy `.env.example` to a new file called `.env`. Open it with Notepad.
2. Fill in `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`, the same values you had in Vercel.
3. Leave `MT5_LOGIN`, `MT5_PASSWORD` and `MT5_SERVER` **blank**. The bot then uses the account logged in to MT5, so your password doesn't have to be stored in this file.

### 4. Check it works
```
python bot.py status
python bot.py telegram-test
```
`status` should show your demo balance, and `Trading allowed: yes`.

### 5. Run the lab
```
python bot.py lab
```
This downloads about 10 years of daily prices from MT5 and tests the three strategy families. It tunes them on the first 65% of the history and judges them once on the last 35%. It takes a few minutes, then saves the chosen strategy and sends you the results on Telegram. If nothing passes, demo trading continues as a forward test, and real money stays locked.

### 6. Preview, then start
```
python bot.py run --force --dry-run     (shows what it would do, sends no orders)
python bot.py run --force               (does it for real on your demo)
```

### 7. Switch on the hourly schedule
Double-click **`install_task.bat`**. It creates a scheduled task called **JijazyFX** that runs every hour. The task also runs on battery and catches up after the laptop wakes up. Its output goes to `data\scheduler.log`.

To stop it, double-click `uninstall_task.bat`, or `pause` the bot (see below).

**Laptop settings:** Settings → System → Power → set **"When plugged in, put my device to sleep after"** to **Never**. Keep MT5 open, or the bot will start it when it needs it.

---

## Day to day

| Command | What it does |
|---|---|
| `python bot.py status` | account, balance, strategy, flags |
| `python bot.py positions` | the bot's open trades |
| `python bot.py signals` | today's signals (no trading) |
| `python bot.py results` | how the bot's closed trades went |
| `python bot.py close EURUSD` / `close all` | close the bot's trades now |
| `python bot.py pause` / `resume` | stop / allow new trades (stops are still managed) |
| `python bot.py gate` | what real-money trading still needs |
| `python bot.py unlock-live` / `lock-live` | allow a REAL account to trade |
| `python bot.py lab` | re-run the strategy test |

**The bot never touches your own trades.** Its orders carry magic number `20261115`, and it only manages positions with that number.

## Safety rules (in `jijazy/config.py`)
- every trade risks 1% of equity, with the stop placed on the broker's server in the same order
- at most 4 open trades, and at most 2 leaning the same way on one currency
- total position value ≤ 5× equity
- no new trades after a 3% drop since the last daily run
- one entry per symbol per day
- if the account is too small to trade the minimum lot within 1% risk, it **skips** the trade instead of risking more

## Real money
A real account is skipped until you run `unlock-live`. That only works once the lab gives a **PASS** *and* a demo account has forward-tested for **8+ weeks, with 20+ closed trades, in profit**. Then you have to type `I UNDERSTAND REAL MONEY`. To switch to real, log in to the real account in MT5 afterwards. The demo record is kept separately, per login.

## Honest caveats
- Testing three families and picking one adds some selection bias. The forward test exists to catch that.
- Octa accounts are swap-free, so the backtest charges no overnight fees.
- Past results are not a promise.

## Files
```
bot.py               the commands above
jijazy/strategies.py strategy rules (line-by-line port of the old fx.js)
jijazy/backtest.py   backtester        jijazy/lab.py   the lab
jijazy/trader.py     the daily run     jijazy/broker.py the only file that talks to MT5
jijazy/state.py      memory in data/state.json (replaces Redis)
tests/               offline tests with a fake MT5:  python -m unittest discover -s tests
```
