#!/usr/bin/env node
/**
 * IBIT ETF Creation/Redemption Arbitrage — Phase 2: Live Monitor
 *
 * Real-time monitoring of IBIT premium/discount vs BTC spot price.
 * Logs simulated arb trades when spread exceeds threshold.
 *
 * Data sources:
 *   - Binance WebSocket for real-time BTC price
 *   - Yahoo Finance for IBIT real-time quote
 *   - BlackRock iShares for BTC-per-share ratio
 *
 * Usage:
 *   node monitor.js              # Live mode
 *   node monitor.js --dry-run    # Simulated prices for testing
 */

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance();
const { fetchBlackrockHoldings, totalCostBps, fmt, fmtUsd, fetchJson } = require('./lib/utils');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8'));

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');

// ─── State ──────────────────────────────────────────────────────────────────

const state = {
  ibitBid: 0,
  ibitAsk: 0,
  ibitLast: 0,
  btcPrice: 0,
  btcPerShare: 0.000567, // default, updated from BlackRock
  trades: [],
  startTime: Date.now(),
  lastIbitFetch: 0,
};

const TRADE_LOG = path.join(__dirname, 'trades.csv');

// ─── CSV Logging ────────────────────────────────────────────────────────────

function initCsv() {
  if (!fs.existsSync(TRADE_LOG)) {
    fs.writeFileSync(
      TRADE_LOG,
      'timestamp,signal,ibit_price,btc_price,nav_estimate,spread_bps,pnl_usd\n'
    );
  }
}

function logTrade(trade) {
  state.trades.push(trade);
  const line = [
    trade.timestamp,
    trade.signal,
    trade.ibitPrice.toFixed(4),
    trade.btcPrice.toFixed(2),
    trade.navEstimate.toFixed(4),
    trade.spreadBps.toFixed(2),
    trade.pnl.toFixed(2),
  ].join(',');
  fs.appendFileSync(TRADE_LOG, line + '\n');
}

// ─── BTC Price Feed ─────────────────────────────────────────────────────────

function startBtcFeed() {
  if (DRY_RUN) {
    state.btcPrice = 84000;
    setInterval(() => {
      state.btcPrice *= 1 + (Math.random() - 0.5) * 0.002;
    }, 1000);
    console.log('[DRY RUN] Simulated BTC feed started');
    return;
  }

  const wsUrl = config.coinbase.wsUrl;
  console.log(`Connecting to Coinbase WebSocket...`);

  function connect() {
    const ws = new WebSocket(wsUrl);
    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'subscribe',
        product_ids: ['BTC-USD'],
        channels: ['ticker']
      }));
      console.log('Subscribed to Coinbase BTC-USD ticker');
    });
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'ticker' && msg.price) {
          state.btcPrice = parseFloat(msg.price);
        }
      } catch {}
    });
    ws.on('error', (err) => console.error('BTC WS error:', err.message));
    ws.on('close', () => {
      console.warn('BTC WS closed, reconnecting in 5s...');
      setTimeout(connect, 5000);
    });
  }
  connect();
}

// ─── IBIT Price Feed ────────────────────────────────────────────────────────

async function fetchIbitQuote() {
  if (DRY_RUN) {
    const nav = state.btcPrice * state.btcPerShare;
    const noise = (Math.random() - 0.5) * 0.006; // ±30bps noise
    const mid = nav * (1 + noise);
    const spread = mid * 0.0003;
    state.ibitBid = mid - spread / 2;
    state.ibitAsk = mid + spread / 2;
    state.ibitLast = mid;
    return;
  }

  // Rate limit: don't fetch more than once per 10 seconds
  if (Date.now() - state.lastIbitFetch < 10000) return;
  state.lastIbitFetch = Date.now();

  try {
    const quote = await yahooFinance.quote(config.etf.ticker);
    state.ibitBid = quote.bid || quote.regularMarketPrice || 0;
    state.ibitAsk = quote.ask || quote.regularMarketPrice || 0;
    state.ibitLast = quote.regularMarketPrice || 0;
  } catch (e) {
    // Silently skip — will retry next cycle
  }
}

// ─── Signal Detection ───────────────────────────────────────────────────────

function checkSignal() {
  const mid = state.ibitBid > 0 && state.ibitAsk > 0
    ? (state.ibitBid + state.ibitAsk) / 2
    : state.ibitLast;

  if (mid <= 0 || state.btcPrice <= 0) return null;

  const nav = state.btcPrice * state.btcPerShare;
  if (nav <= 0) return null;

  const premBps = ((mid - nav) / nav) * 10000;
  const costBps = totalCostBps(config, mid);
  const trigger = costBps + config.signals.minSpreadAfterCostsBps;

  if (Math.abs(premBps) > trigger) {
    const signal = premBps > 0 ? 'CREATE' : 'REDEEM';
    const spreadCaptured = Math.abs(premBps) - costBps;
    const pnl = (spreadCaptured / 10000) * config.etf.creationUnitShares * mid;

    return {
      timestamp: new Date().toISOString(),
      signal,
      ibitPrice: mid,
      btcPrice: state.btcPrice,
      navEstimate: nav,
      spreadBps: spreadCaptured,
      pnl,
    };
  }
  return null;
}

// ─── Dashboard ──────────────────────────────────────────────────────────────

function printDashboard() {
  const mid = state.ibitBid > 0 && state.ibitAsk > 0
    ? (state.ibitBid + state.ibitAsk) / 2
    : state.ibitLast;
  const nav = state.btcPrice * state.btcPerShare;
  const premBps = nav > 0 ? ((mid - nav) / nav) * 10000 : 0;
  const costBps = mid > 0 ? totalCostBps(config, mid) : 0;
  const trigger = costBps + config.signals.minSpreadAfterCostsBps;

  let signalStr = '⚪ NEUTRAL';
  if (premBps > trigger) signalStr = '🟢 CREATE_SIGNAL';
  else if (premBps < -trigger) signalStr = '🔴 REDEEM_SIGNAL';

  const totalPnl = state.trades.reduce((s, t) => s + t.pnl, 0);
  const winCount = state.trades.filter((t) => t.pnl > 0).length;
  const winRate = state.trades.length > 0 ? (winCount / state.trades.length) * 100 : 0;
  const elapsed = ((Date.now() - state.startTime) / 60000).toFixed(1);
  const now = new Date().toLocaleTimeString();

  // Clear screen
  process.stdout.write('\x1Bc');

  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║  IBIT ARBITRAGE MONITOR ${DRY_RUN ? '(DRY RUN)' : '(LIVE)'}          ${now.padStart(15)}  ║
╠══════════════════════════════════════════════════════════════════╣
║  IBIT  Bid: $${fmt(state.ibitBid, 4).padStart(10)}  Ask: $${fmt(state.ibitAsk, 4).padStart(10)}  Mid: $${fmt(mid, 4).padStart(10)}  ║
║  BTC   Price: $${fmt(state.btcPrice, 2).padStart(12)}                                   ║
║  NAV   Est:   $${fmt(nav, 4).padStart(12)}     BTC/Share: ${state.btcPerShare.toFixed(8)}    ║
╠══════════════════════════════════════════════════════════════════╣
║  Premium/Discount: ${(premBps >= 0 ? '+' : '') + fmt(premBps, 1)}  bps                                   ║
║  Cost threshold:   ±${fmt(trigger, 1)} bps                                     ║
║  Signal: ${signalStr.padEnd(20)}                                    ║
╠══════════════════════════════════════════════════════════════════╣
║  Session: ${elapsed} min | Trades: ${String(state.trades.length).padStart(4)} | Win: ${fmt(winRate, 1)}% | PnL: ${fmtUsd(totalPnl).padStart(12)} ║
║  Data: ${DRY_RUN ? 'Simulated' : 'Binance WS + Yahoo Finance + BlackRock'}                             ║
╚══════════════════════════════════════════════════════════════════╝
`);

  // Show last 5 trades
  if (state.trades.length > 0) {
    console.log('  Recent Trades:');
    const recent = state.trades.slice(-5);
    for (const t of recent) {
      const icon = t.signal === 'CREATE' ? '🟢' : '🔴';
      const time = t.timestamp.slice(11, 19);
      console.log(
        `    ${icon} ${time} ${t.signal.padEnd(7)} | Spread: ${fmt(t.spreadBps, 1).padStart(6)} bps | PnL: ${fmtUsd(t.pnl).padStart(10)}`
      );
    }
  }
}

// ─── Main Loop ──────────────────────────────────────────────────────────────

async function main() {
  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║  IBIT Arbitrage — Phase 2: Live Monitor              ║');
  console.log(`║  Mode: ${DRY_RUN ? 'DRY RUN (simulated prices)' : 'LIVE (Binance + Yahoo + BlackRock)'}       ║`);
  console.log('╚═══════════════════════════════════════════════════════╝\n');

  // Get BTC per share from BlackRock
  if (!DRY_RUN) {
    try {
      const holdings = await fetchBlackrockHoldings(config);
      state.btcPerShare = holdings.btcQuantity / 1_380_240_000;
      console.log(`BlackRock BTC per share: ${state.btcPerShare.toFixed(8)}`);
    } catch (e) {
      console.warn(`Using default BTC per share: ${state.btcPerShare}`);
    }
  }

  initCsv();
  startBtcFeed();

  // Wait for initial data
  console.log('Waiting for price data...');
  await new Promise((r) => setTimeout(r, 3000));

  // Main loop
  let tick = 0;
  const interval = setInterval(async () => {
    await fetchIbitQuote();

    const trade = checkSignal();
    if (trade) {
      logTrade(trade);
      const icon = trade.signal === 'CREATE' ? '🟢' : '🔴';
      console.log(
        `\n${icon} ${trade.signal} SIGNAL | Spread: ${fmt(trade.spreadBps, 1)} bps | PnL: ${fmtUsd(trade.pnl)}`
      );
    }

    // Dashboard every 5 ticks (5 seconds)
    if (tick % 5 === 0) {
      printDashboard();
    }
    tick++;
  }, 1000);

  // Graceful shutdown
  const shutdown = () => {
    clearInterval(interval);
    const totalPnl = state.trades.reduce((s, t) => s + t.pnl, 0);
    const elapsed = ((Date.now() - state.startTime) / 60000).toFixed(1);
    console.log(`\n${'='.repeat(55)}`);
    console.log('  SESSION SUMMARY');
    console.log('='.repeat(55));
    console.log(`  Duration      : ${elapsed} minutes`);
    console.log(`  Total trades  : ${state.trades.length}`);
    console.log(`  Total P&L     : ${fmtUsd(totalPnl)}`);
    console.log(`  Trade log     : ${TRADE_LOG}`);
    console.log('='.repeat(55));
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
