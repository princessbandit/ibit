#!/usr/bin/env node
/**
 * IBIT ETF Creation/Redemption Arbitrage — Web Dashboard
 *
 * Real-time web UI showing IBIT premium/discount, arb signals, and trade log.
 * Express + Socket.IO backend, Chart.js frontend.
 *
 * Data sources (live mode):
 *   - Coinbase WebSocket  → BTC spot price
 *   - Yahoo Finance       → IBIT real-time quote
 *
 * Usage:
 *   node dashboard.js              # Live mode (port 5000)
 *   node dashboard.js --dry-run    # Simulated prices
 *   node dashboard.js --port 8080  # Custom port
 */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const WebSocket  = require('ws');
const { totalCostBps, fmt, fmtUsd } = require('./lib/utils');

// yahoo-finance2 ships ESM-only; load it lazily via dynamic import so this
// CJS file doesn't crash on startup when running in --dry-run (which never
// hits the Yahoo API).
let yahooFinance;
async function getYahooFinance() {
  if (!yahooFinance) {
    const { default: YahooFinance } = await import('yahoo-finance2');
    yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
  }
  return yahooFinance;
}
const discord = require('./lib/discord');

const config  = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8'));
const args    = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const portIdx = args.indexOf('--port');
const PORT    = portIdx >= 0 ? parseInt(args[portIdx + 1]) : 5000;

// ─── State ──────────────────────────────────────────────────────────────────

const state = {
  ibitBid: 0, ibitAsk: 0, ibitLast: 0,
  btcPrice: 0,
  btcPerShare: config.etf.btcPerShare || 0.000569, // updated dynamically from live prices
  btcPerShareSource: 'config',                      // 'config' | 'live'
  trades:  [],
  history: [],
  startTime: Date.now(),
  lastIbitFetch: 0,
};

const TRADE_LOG = path.join(__dirname, 'trades.csv');

// ─── Trade CSV ──────────────────────────────────────────────────────────────

function initCsv() {
  if (!fs.existsSync(TRADE_LOG)) {
    fs.writeFileSync(TRADE_LOG, 'timestamp,signal,ibit_price,btc_price,nav_estimate,spread_bps,pnl_usd\n');
  }
}

function logTrade(trade) {
  state.trades.push(trade);
  const line = [
    trade.timestamp, trade.signal,
    trade.etfPrice.toFixed(4), trade.btcPrice.toFixed(2),
    trade.navEstimate.toFixed(4), trade.spreadBps.toFixed(2), trade.pnl.toFixed(2),
  ].join(',');
  fs.appendFileSync(TRADE_LOG, line + '\n');
}

// ─── Data Feeds ─────────────────────────────────────────────────────────────

function startBtcFeed() {
  if (DRY_RUN) {
    state.btcPrice = 77000;
    setInterval(() => { state.btcPrice *= 1 + (Math.random() - 0.5) * 0.002; }, 1000);
    console.log('[DRY RUN] Simulated BTC feed at $77,000');
    return;
  }
  const wsUrl = config.coinbase.wsUrl;
  console.log('Connecting to Coinbase WebSocket...');
  function connect() {
    const ws = new WebSocket(wsUrl);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'subscribe', product_ids: ['BTC-USD'], channels: ['ticker'] }));
      console.log('Subscribed to Coinbase BTC-USD ticker');
    });
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'ticker' && msg.price) state.btcPrice = parseFloat(msg.price);
      } catch {}
    });
    ws.on('error', e => console.error('BTC WS error:', e.message));
    ws.on('close', () => { setTimeout(connect, 5000); });
  }
  connect();
}

async function fetchIbitQuote() {
  if (DRY_RUN) {
    const nav = state.btcPrice * state.btcPerShare;
    const noise = (Math.random() - 0.5) * 0.008;
    const mid = nav * (1 + noise);
    const spread = mid * 0.0002;
    state.ibitBid  = mid - spread / 2;
    state.ibitAsk  = mid + spread / 2;
    state.ibitLast = mid;
    return;
  }
  if (Date.now() - state.lastIbitFetch < 10000) return;
  state.lastIbitFetch = Date.now();
  try {
    const yf = await getYahooFinance();
    const q = await yf.quote(config.etf.ticker);
    state.ibitBid  = q.bid  || q.regularMarketPrice || 0;
    state.ibitAsk  = q.ask  || q.regularMarketPrice || 0;
    state.ibitLast = q.regularMarketPrice || 0;

    // Dynamically update btcPerShare from live prices
    const mid = (state.ibitBid > 0 && state.ibitAsk > 0)
      ? (state.ibitBid + state.ibitAsk) / 2
      : state.ibitLast;
    if (mid > 0 && state.btcPrice > 0) {
      state.btcPerShare = mid / state.btcPrice;
      state.btcPerShareSource = 'live';
    }
  } catch {}
}

// ─── Snapshot / Signal ──────────────────────────────────────────────────────

function getSnapshot() {
  const mid = (state.ibitBid > 0 && state.ibitAsk > 0)
    ? (state.ibitBid + state.ibitAsk) / 2 : state.ibitLast;
  const nav     = state.btcPrice * state.btcPerShare;
  const premBps = nav > 0 ? ((mid - nav) / nav) * 10000 : 0;
  const costBps = mid > 0 ? totalCostBps(config, mid) : 0;
  const trigger = costBps + config.signals.minSpreadAfterCostsBps;

  let signal = 'NEUTRAL';
  if (premBps > trigger)  signal = 'CREATE';
  if (premBps < -trigger) signal = 'REDEEM';

  const totalPnl = state.trades.reduce((s, t) => s + t.pnl, 0);
  const wins     = state.trades.filter(t => t.pnl > 0).length;
  const winRate  = state.trades.length > 0 ? wins / state.trades.length * 100 : 0;

  return {
    timestamp: new Date().toISOString(),
    etfBid: state.ibitBid, etfAsk: state.ibitAsk, etfMid: mid,
    btcPrice: state.btcPrice, nav, premBps, costBps, trigger, signal,
    btcPerShare: state.btcPerShare,
    btcPerShareSource: state.btcPerShareSource,
    tradeCount: state.trades.length, totalPnl, winRate,
    elapsed: ((Date.now() - state.startTime) / 60000).toFixed(1),
    dryRun: DRY_RUN,
  };
}

function checkSignal() {
  const snap = getSnapshot();
  if (snap.signal === 'NEUTRAL' || snap.etfMid <= 0) return null;
  const spreadCaptured = Math.abs(snap.premBps) - snap.costBps;
  const pnl = (spreadCaptured / 10000) * config.etf.creationUnitShares * snap.etfMid;
  return {
    timestamp:   new Date().toISOString(),
    signal:      snap.signal,
    etfPrice:    snap.etfMid,
    btcPrice:    snap.btcPrice,
    navEstimate: snap.nav,
    spreadBps:   spreadCaptured,
    pnl,
  };
}

// ─── Express + Socket.IO ────────────────────────────────────────────────────

const PUBLIC_DIR = path.resolve(__dirname, 'public');
const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

app.use(express.static(PUBLIC_DIR));
app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('/api/state',   (req, res) => res.json(getSnapshot()));
app.get('/api/history', (req, res) => res.json(state.history));
app.get('/api/trades',  (req, res) => res.json(state.trades.slice(-100)));
app.get('/api/config',  (req, res) => res.json(config));

io.on('connection', (socket) => {
  socket.emit('snapshot', getSnapshot());
  socket.emit('history',  state.history);
  socket.emit('trades',   state.trades.slice(-50));
});

// ─── Main Loop ──────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n  IBIT Arbitrage Dashboard — ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log(`  BlackRock iShares Bitcoin Trust ETF | Custodian: Coinbase Custody`);
  console.log(`  Starting on http://localhost:${PORT}\n`);

  initCsv();
  await discord.init();
  startBtcFeed();
  await new Promise(r => setTimeout(r, 2000));

  setInterval(async () => {
    await fetchIbitQuote();
    const snap = getSnapshot();

    state.history.push({
      t: snap.timestamp,
      premBps: snap.premBps,
      etfMid: snap.etfMid,
      btcPrice: snap.btcPrice,
      nav: snap.nav,
    });
    if (state.history.length > 3600) state.history.shift();

    const trade = checkSignal();
    if (trade) {
      logTrade(trade);
      io.emit('trade', trade);
      discord.sendTradeAlert(trade).catch(() => {});
      const icon = trade.signal === 'CREATE' ? '🟢' : '🔴';
      console.log(`  ${icon} ${trade.signal} | Spread: ${trade.spreadBps.toFixed(1)} bps | PnL: $${trade.pnl.toFixed(2)}`);
    }

    io.emit('snapshot', snap);
  }, 1000);

  server.listen(PORT, () => {
    console.log(`  ✅ Dashboard: http://localhost:${PORT}`);
    console.log(`  Press Ctrl+C to stop\n`);
  });

  process.on('SIGINT', () => {
    const totalPnl = state.trades.reduce((s, t) => s + t.pnl, 0);
    console.log(`\n  Trades: ${state.trades.length} | P&L: $${totalPnl.toFixed(2)}`);
    process.exit(0);
  });
}

main().catch(e => { console.error(e); process.exit(1); });
