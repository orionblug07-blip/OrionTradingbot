#!/usr/bin/env node
/**
 * Run the strategy lab from your own computer:
 *   npm run lab                      (all FX_SYMBOLS, ~10 years)
 *   npm run lab -- --bars 1500       (fewer days)
 *   npm run lab -- --symbols EURUSD,GBPUSD
 *
 * Needs METAAPI_TOKEN and either FX_DATA_ACCOUNT_ID or the Upstash settings in
 * .env (then it uses the admin's connected account). Writes the result to
 * data/fx-strategy.json — commit and push it so the deployed bot uses it.
 * (Running `lab run` in Telegram does the same without a computer.)
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const cfg = require('../src/config');
const lab = require('../src/services/lab');
const autoTrader = require('../src/services/autoTrader');

const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };

(async () => {
  const bars = Number(arg('bars', 2700));
  const symbols = (arg('symbols', '') || '').split(',').filter(Boolean);
  const acct = await autoTrader.dataAccount();
  console.log(`Downloading daily candles via MetaApi account ${acct.id} (${acct.region})…`);
  const data = await lab.loadData(acct, symbols.length ? symbols : cfg.symbols(), bars, (m) => console.log('  ' + m));
  const result = lab.runLab(data);
  const out = path.join(__dirname, '..', cfg.STRATEGY_FILE);
  fs.writeFileSync(out, JSON.stringify(result, null, 2));
  console.log('\n' + lab.summary(result).replace(/[*_`]/g, ''));
  console.log(`\nSaved ${out}. Commit and push it so the deployed bot uses it.`);
})().catch(err => { console.error(err.message); process.exit(1); });
