# Setting up JijazyFX, step by step

You'll need: a GitHub account, a Vercel account, the MetaApi token, the new Telegram bot token, a new Upstash database, and your Octa MT5 demo login. None of the steps need you to share a password with anyone.

## 1. Put the code on GitHub
1. Create a **new private repository** on GitHub, e.g. `jijazyfx`.
2. Upload the contents of this folder, or push it from VS Code: `git init`, `git add .`, `git commit -m "JijazyFX"`, then follow GitHub's "push an existing repository" commands.
   `.env` is git-ignored, so your secrets stay off GitHub.

## 2. Generate three secrets
In a terminal (PowerShell or Git Bash), run:
```bash
openssl rand -hex 24   # → CRON_SECRET
openssl rand -hex 24   # → TELEGRAM_WEBHOOK_SECRET
openssl rand -hex 32   # → TRADING_ENCRYPTION_KEY (must be 64 characters)
```
No openssl? Run this instead: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

## 3. Deploy on Vercel
1. Vercel → **Add New → Project** → import the GitHub repository.
2. Open **Settings → Environment Variables** and add:
   - `TELEGRAM_BOT_TOKEN`: from @BotFather
   - `TELEGRAM_CHAT_ID`: your own Telegram id (send `/start` to @userinfobot to see it)
   - `CRON_SECRET`, `TELEGRAM_WEBHOOK_SECRET`, `TRADING_ENCRYPTION_KEY`: from step 2
   - `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`: from the new Upstash database
   - `METAAPI_TOKEN`: from app.metaapi.cloud/token
   - optional: `METAAPI_REGION=london`
3. **Deploy.** Note the address, e.g. `https://jijazyfx.vercel.app`.

## 4. Connect Telegram
Open `https://YOUR-APP.vercel.app/api/set-commands?key=YOUR_CRON_SECRET` once in your browser. It should show `"ok": true`.

## 5. Check the setup
Open `https://YOUR-APP.vercel.app/api/health?key=YOUR_CRON_SECRET`. `missing` should be empty. MetaApi will say there's no account until step 6.

## 6. Connect your Octa demo account (in Telegram)
1. Open your new bot and send `/start`.
2. Send your login, password and server in one message:
   `connect 12345678 YourPassword OctaFX-Demo`
   - Use the **main** password, not the investor one.
   - Copy the server name exactly as Octa shows it.
   - The bot deletes your message straight away.
3. Wait for "✅ Connected". After a few minutes, `status` should show your balance.

## 7. Run the lab
Send `lab run`. It takes a few minutes and sends you the results. If nothing passes, real money stays locked. That's expected, and it protects you.

## 8. Switch on demo auto-trading
Send `auto on`. The first check runs after the next daily candle closes. You can also send `run now` to try it straight away; it only trades if there's a signal.

## 9. Schedule the hourly job
On cron-job.org (or any cron service), create a job:
- URL: `https://YOUR-APP.vercel.app/api/cron?key=YOUR_CRON_SECRET`
- Schedule: **every hour**

The job checks the bot every hour but trades only once per daily candle.

## Day to day
- `status`, `positions`, `signals`, `results` show what's happening.
- `gate` shows what real-money trading still needs: a lab PASS, plus 8 weeks / 20 trades / profit on the demo forward test.
- If anything looks wrong, send `pause`. Open trades keep their stops on the broker's server.
- To test without sending orders, set `AUTOTRADE_DRY_RUN=true` in Vercel. The bot then reports what it *would* do.
