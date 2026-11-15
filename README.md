# JijazyFX

A Telegram bot that auto-trades forex on each user's own **MetaTrader 5** account (Octa, or any MT5 broker), through [MetaApi](https://metaapi.cloud). It runs on Vercel serverless functions with Upstash Redis, like JijazyBot.

**The rules it follows:**
- **Demo first.** Real-money accounts can't auto-trade until the admin unlocks live trading. The bot only allows that once the strategy has **passed the lab test** *and* the admin's demo account has run an 8-week forward test (20+ closed trades, in profit).
- **Every trade risks 1% of equity**, and its stop is placed on the broker's server in the same order. If MetaApi or the bot goes down, the stop still works.
- **It never touches your own trades.** Bot orders carry their own magic number (`20261115`).
- **The password is not kept.** `connect` deletes the user's message at once. The MT5 password goes to MetaApi; the bot holds it encrypted only for the few minutes MetaApi takes to check the account.

## How it trades

Once a day, after the daily candle closes, the bot:

1. Downloads daily candles for the symbols (default: EURUSD, GBPUSD, USDJPY, AUDUSD, USDCAD, USDCHF, NZDUSD, XAUUSD) from the broker via MetaApi.
2. Checks the strategy the lab chose. There are three strategy families, each trading both long and short:
   - **Breakout:** the close breaks the N-day high or low. The stop trails the M-day low or high.
   - **Trend pullback:** the fast EMA is above (or below) the slow EMA, and the close crosses back over the fast EMA. The stop trails k×ATR.
   - **Momentum:** the L-day return turns positive or negative on the same side of the 100-day EMA. The stop trails k×ATR.
3. For each user with auto-trading on:
   - reports trades that hit their stop
   - tightens open stops (never loosens them)
   - opens new trades with a server-side stop, and tells the user **why**

**Safety limits** (`src/config.js`):
- 1% risk per trade
- max 4 open trades
- max 2 trades leaning the same way on one currency
- total position value ≤ 5× equity
- no new trades after a 3% daily drop
- one entry per symbol per day
- the admin can `pause` everything

## The lab (`lab run` in Telegram, or `npm run lab`)

1. Downloads about 10 years of daily candles from the broker.
2. Uses the first 65% of that history to choose each family's settings (best average result with 30+ trades).
3. Judges those settings **once** on the remaining 35%, which the choosing step never saw. Costs are the broker's spread plus slippage, with a cautious floor.
4. **PASS** = at least 30 trades on the unseen data, *and* the whole 95% range of the average result is above zero.

If nothing passes, demo trading continues as a forward test and real money stays locked.

**Honest caveats:**
- Testing three families and picking one adds some selection bias. The forward test exists to catch that.
- Octa accounts are swap-free, so the backtest charges no overnight fees. For a broker that charges swaps, results would be worse for long holds.
- Past results are not a promise.

## Telegram commands

**Users:**
- `connect LOGIN PASSWORD SERVER`
- `status`
- `positions`
- `auto on` / `auto off`
- `signals`
- `strategy`
- `results`
- `close EURUSD` / `close all`
- `disconnect`

**Admin:**
- `lab run`
- `run now`
- `pause` / `resume`
- `gate`
- `unlock live` / `lock live`
- `users` · `approve ID` · `block ID`

New users ask for access, and the admin approves them with one tap.

## Endpoints

| Endpoint | When | What |
|---|---|---|
| `/api/telegram-webhook` | Telegram | Bot updates (checked against `TELEGRAM_WEBHOOK_SECRET`) |
| `/api/cron?key=CRON_SECRET` | **every hour** | Finishes pending connects, continues the lab, runs the daily check (acts once per daily candle) |
| `/api/set-commands?key=CRON_SECRET` | once | Registers the webhook and the command menu |
| `/api/health?key=CRON_SECRET` | any time | Setup check |

## Costs to know about

- **MetaApi** bills per connected MT5 account (one account free at the time of writing; check their pricing). Every user who connects runs on **your** MetaApi token, so plan who pays before opening the bot to others. `disconnect` removes the account from MetaApi.
- Accounts are created with `reliability: regular` (cheaper). Change it in `src/lib/metaapi.js` if you want MetaApi's standby copy.

## Before opening it to the public

Auto-trading other people's accounts may need a licence. In September 2026, SEC Nigeria proposed rules for online forex trading platforms. Get legal advice before taking paying users.

## Local use

```bash
npm install
cp .env.example .env   # fill in
npm test               # 50 offline tests (no network)
npm run lab            # needs METAAPI_TOKEN + FX_DATA_ACCOUNT_ID or Upstash; writes data/fx-strategy.json
```

## Code layout

```
api/                 telegram-webhook, cron, set-commands, health  (4 Vercel functions)
src/config.js        symbols, safety limits, live-trading gate
src/lib/             metaapi (only file that talks to MetaApi), telegram, redis, auth, secretBox
src/strategies/fx.js the strategy families (shared by lab and live)
src/services/        backtest, lab, labJob (lab in 60-s steps), accounts, autoTrader, users
src/bot/commands.js  Telegram commands
test/                node:test suite with a fake MetaApi broker
```

See `SETUP.md` for step-by-step deployment.
