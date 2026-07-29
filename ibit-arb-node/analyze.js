#!/usr/bin/env node
/**
 * IBIT ETF Creation/Redemption Arbitrage — Phase 1: Historical Analysis
 *
 * Fetches historical IBIT + BTC data, computes premium/discount,
 * identifies arb opportunities, and outputs analysis + CSV.
 *
 * Data sources:
 *   - Yahoo Finance (yahoo-finance2) for IBIT & BTC-USD historical prices
 *   - BlackRock iShares API for current IBIT holdings (BTC per share)
 */

const fs = require('fs');
const path = require('path');
const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance();
const { createObjectCsvWriter } = require('csv-writer');
const { fetchBlackrockHoldings, totalCostBps, fmt, fmtUsd } = require('./lib/utils');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8'));

// ─── Data Fetching ──────────────────────────────────────────────────────────

async function fetchHistorical(ticker, startDate) {
  console.log(`Fetching ${ticker} from ${startDate}...`);
  const result = await yahooFinance.chart(ticker, {
    period1: startDate,
    interval: '1d',
  });
  const quotes = result.quotes || [];
  console.log(`  → ${quotes.length} data points`);
  return quotes;
}

async function getBlackrockBtcPerShare() {
  try {
    console.log('Fetching BlackRock IBIT holdings...');
    const holdings = await fetchBlackrockHoldings(config);
    console.log(`  BTC held: ${fmt(holdings.btcQuantity, 2)}`);
    console.log(`  Market value: ${fmtUsd(holdings.marketValue)}`);
    return holdings;
  } catch (e) {
    console.warn(`  Warning: Could not fetch BlackRock data: ${e.message}`);
    return null;
  }
}

// ─── Analysis ───────────────────────────────────────────────────────────────

function buildAnalysis(ibitQuotes, btcQuotes, btcPerShareRatio) {
  // Index BTC by date
  const btcByDate = new Map();
  for (const q of btcQuotes) {
    if (!q.date || q.close == null) continue;
    const key = q.date.toISOString().slice(0, 10);
    btcByDate.set(key, q.close);
  }

  const rows = [];
  for (const q of ibitQuotes) {
    if (!q.date || q.close == null || q.volume == null) continue;
    const dateKey = q.date.toISOString().slice(0, 10);
    const btcClose = btcByDate.get(dateKey);
    if (btcClose == null) continue;

    const navEstimate = btcClose * btcPerShareRatio;
    const premDiscPct = (q.close - navEstimate) / navEstimate;
    const premDiscBps = premDiscPct * 10000;
    const costBps = totalCostBps(config, q.close);
    const triggerBps = costBps + config.signals.minSpreadAfterCostsBps;

    const isCreate = premDiscBps > triggerBps;
    const isRedeem = premDiscBps < -triggerBps;
    const spreadCapturedBps =
      isCreate || isRedeem ? Math.abs(premDiscBps) - costBps : 0;
    const pnlPerTrade =
      (spreadCapturedBps / 10000) * config.etf.creationUnitShares * q.close;

    rows.push({
      date: dateKey,
      ibitClose: q.close,
      ibitVolume: q.volume,
      btcClose,
      navEstimate,
      premDiscBps,
      costBps,
      triggerBps,
      isCreate,
      isRedeem,
      spreadCapturedBps,
      pnlPerTrade,
    });
  }

  return rows;
}

// ─── Reporting ──────────────────────────────────────────────────────────────

function printSummary(rows) {
  const cu = config.etf.creationUnitShares;
  const premDiscValues = rows.map((r) => r.premDiscBps);
  const mean = premDiscValues.reduce((a, b) => a + b, 0) / premDiscValues.length;
  const sorted = [...premDiscValues].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const stdDev = Math.sqrt(
    premDiscValues.reduce((sum, v) => sum + (v - mean) ** 2, 0) / premDiscValues.length
  );
  const min = Math.min(...premDiscValues);
  const max = Math.max(...premDiscValues);

  const creates = rows.filter((r) => r.isCreate);
  const redeems = rows.filter((r) => r.isRedeem);
  const trades = rows.filter((r) => r.isCreate || r.isRedeem);
  const totalDays = rows.length;
  const years = totalDays / 252;

  const avgPrice = rows.reduce((s, r) => s + r.ibitClose, 0) / rows.length;
  const capital = cu * avgPrice;

  const sep = '='.repeat(60);
  console.log(`\n${sep}`);
  console.log(' IBIT ARBITRAGE — HISTORICAL ANALYSIS (Node.js)');
  console.log(sep);
  console.log(` Period          : ${rows[0].date} → ${rows[rows.length - 1].date}`);
  console.log(` Trading days    : ${totalDays}`);
  console.log(` Years           : ${fmt(years)}`);
  console.log('');
  console.log(' Premium/Discount Stats (bps):');
  console.log(`   Mean           : ${fmt(mean, 2).padStart(10)}`);
  console.log(`   Median         : ${fmt(median, 2).padStart(10)}`);
  console.log(`   Std Dev        : ${fmt(stdDev, 2).padStart(10)}`);
  console.log(`   Min            : ${fmt(min, 2).padStart(10)}`);
  console.log(`   Max            : ${fmt(max, 2).padStart(10)}`);
  console.log('');
  console.log(' Cost Breakdown (bps):');
  if (rows.length > 0) {
    const c = config.costs;
    const feeBps = (c.creationRedemptionFeeUsd / (cu * avgPrice)) * 10000;
    const commBps = (c.etfCommissionPerShare / avgPrice) * 10000;
    console.log(`   Create/Redeem fee : ${fmt(feeBps, 2).padStart(8)}`);
    console.log(`   ETF commission    : ${fmt(commBps, 2).padStart(8)}`);
    console.log(`   BTC execution     : ${fmt(c.btcExecutionBps, 2).padStart(8)}`);
    console.log(`   Market impact (x2): ${fmt(c.marketImpactBps * 2, 2).padStart(8)}`);
    console.log(`   BTC spot spread   : ${fmt(c.btcSpotSpreadBps, 2).padStart(8)}`);
    console.log(`   TOTAL             : ${fmt(rows[0].costBps, 2).padStart(8)}`);
  }
  console.log('');
  console.log(' Actionable Opportunities:');
  console.log(
    `   Create signals : ${String(creates.length).padStart(6)}  (${fmt((creates.length / totalDays) * 100, 1)}% of days)`
  );
  console.log(
    `   Redeem signals : ${String(redeems.length).padStart(6)}  (${fmt((redeems.length / totalDays) * 100, 1)}% of days)`
  );
  console.log(
    `   Total trades   : ${String(trades.length).padStart(6)}  (${fmt((trades.length / totalDays) * 100, 1)}% of days)`
  );
  console.log('');

  if (trades.length > 0) {
    const avgPnl = trades.reduce((s, t) => s + t.pnlPerTrade, 0) / trades.length;
    const totalPnl = trades.reduce((s, t) => s + t.pnlPerTrade, 0);
    const annualPnl = totalPnl / years;
    const annualReturn = (annualPnl / capital) * 100;
    const avgSpread = trades.reduce((s, t) => s + t.spreadCapturedBps, 0) / trades.length;

    console.log(` P&L Analysis (creation unit = ${cu.toLocaleString()} shares):`);
    console.log(`   Capital required : ${fmtUsd(capital).padStart(18)}`);
    console.log(`   Avg spread capt. : ${fmt(avgSpread, 2).padStart(10)} bps`);
    console.log(`   Avg P&L / trade  : ${fmtUsd(avgPnl).padStart(18)}`);
    console.log(`   Total P&L        : ${fmtUsd(totalPnl).padStart(18)}`);
    console.log(`   Annualized P&L   : ${fmtUsd(annualPnl).padStart(18)}`);
    console.log(`   Annualized Return: ${fmt(annualReturn, 2).padStart(10)}%`);
  } else {
    console.log(' No actionable opportunities at current thresholds.');
  }
  console.log(sep);
}

// ─── CSV Export ─────────────────────────────────────────────────────────────

async function exportCsv(rows, filepath) {
  const writer = createObjectCsvWriter({
    path: filepath,
    header: [
      { id: 'date', title: 'Date' },
      { id: 'ibitClose', title: 'IBIT Close' },
      { id: 'btcClose', title: 'BTC Close' },
      { id: 'navEstimate', title: 'NAV Estimate' },
      { id: 'premDiscBps', title: 'Premium/Discount (bps)' },
      { id: 'costBps', title: 'Cost (bps)' },
      { id: 'isCreate', title: 'Create Signal' },
      { id: 'isRedeem', title: 'Redeem Signal' },
      { id: 'spreadCapturedBps', title: 'Spread Captured (bps)' },
      { id: 'pnlPerTrade', title: 'P&L Per Trade (USD)' },
    ],
  });
  await writer.writeRecords(
    rows.map((r) => ({
      ...r,
      ibitClose: r.ibitClose.toFixed(4),
      btcClose: r.btcClose.toFixed(2),
      navEstimate: r.navEstimate.toFixed(4),
      premDiscBps: r.premDiscBps.toFixed(2),
      costBps: r.costBps.toFixed(2),
      spreadCapturedBps: r.spreadCapturedBps.toFixed(2),
      pnlPerTrade: r.pnlPerTrade.toFixed(2),
    }))
  );
  console.log(`\nExported analysis to ${filepath}`);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  IBIT Arbitrage — Phase 1: Historical Analysis         ║');
  console.log('║  Data: Yahoo Finance + BlackRock iShares               ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  // 1. Fetch BlackRock holdings for accurate BTC-per-share ratio
  const blackrock = await getBlackrockBtcPerShare();

  // 2. Fetch historical data
  const startDate = config.analysis.startDate;
  const [ibitQuotes, btcQuotes] = await Promise.all([
    fetchHistorical(config.etf.ticker, startDate),
    fetchHistorical(config.bitcoin.ticker, startDate),
  ]);

  // 3. Calculate BTC per share ratio
  //    Best source: BlackRock holdings (BTC qty / shares outstanding)
  //    Fallback: derive from first day IBIT price / BTC price
  let btcPerShare;
  if (blackrock) {
    // BlackRock gives us total BTC; we need shares outstanding
    // Shares outstanding from recent data: ~1.38B shares, 782,429 BTC
    // btcPerShare = 782429 / 1380240000 ≈ 0.000567
    btcPerShare = blackrock.btcQuantity / 1_380_240_000; // Using known shares outstanding
    console.log(`\nBTC per share (BlackRock): ${btcPerShare.toFixed(8)}`);
  } else {
    // Fallback: first-day ratio
    const firstIbit = ibitQuotes.find((q) => q.close)?.close || 1;
    const firstBtc = btcQuotes.find((q) => q.close)?.close || 1;
    btcPerShare = firstIbit / firstBtc;
    console.log(`\nBTC per share (estimated from day 1): ${btcPerShare.toFixed(8)}`);
  }

  // 4. Build analysis
  const rows = buildAnalysis(ibitQuotes, btcQuotes, btcPerShare);
  if (rows.length === 0) {
    console.error('No overlapping data found. Check date range and tickers.');
    process.exit(1);
  }

  // 5. Print summary
  printSummary(rows);

  // 6. Export CSV
  const csvPath = path.join(__dirname, 'analysis.csv');
  await exportCsv(rows, csvPath);

  // 7. Monthly breakdown
  console.log('\n Monthly Breakdown:');
  console.log(' ─────────────────────────────────────────────────────');
  console.log(' Month       | Days | Creates | Redeems | Total P&L');
  console.log(' ─────────────────────────────────────────────────────');

  const byMonth = new Map();
  for (const r of rows) {
    const month = r.date.slice(0, 7);
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month).push(r);
  }

  for (const [month, monthRows] of byMonth) {
    const creates = monthRows.filter((r) => r.isCreate).length;
    const redeems = monthRows.filter((r) => r.isRedeem).length;
    const pnl = monthRows.reduce((s, r) => s + r.pnlPerTrade, 0);
    console.log(
      ` ${month}    |  ${String(monthRows.length).padStart(3)} |     ${String(creates).padStart(3)} |     ${String(redeems).padStart(3)} | ${fmtUsd(pnl).padStart(14)}`
    );
  }
  console.log(' ─────────────────────────────────────────────────────');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
