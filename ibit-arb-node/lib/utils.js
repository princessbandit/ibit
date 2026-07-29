/**
 * IBIT ETF Arbitrage — Shared utilities
 */
const https = require('https');
const http = require('http');

/**
 * Fetch JSON from a URL (simple built-in, no deps)
 */
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const zlib = require('zlib');
    mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Encoding': 'identity', 'Accept': 'application/json' } }, (res) => {
      let stream = res;
      if (res.headers['content-encoding'] === 'gzip') {
        stream = res.pipe(zlib.createGunzip());
      } else if (res.headers['content-encoding'] === 'deflate') {
        stream = res.pipe(zlib.createInflate());
      }
      let data = '';
      stream.on('data', (chunk) => (data += chunk));
      stream.on('end', () => {
        try {
          // Strip BOM if present
          if (data.charCodeAt(0) === 0xFEFF) data = data.slice(1);
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse JSON from ${url}: ${e.message}\nBody: ${data.slice(0, 200)}`));
        }
      });
      stream.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * Fetch current IBIT holdings from BlackRock iShares
 * Returns { btcQuantity, sharesOutstanding, btcPerShare, marketValue }
 */
async function fetchBlackrockHoldings(config) {
  const url = config.blackrock.holdingsUrl;
  const json = await fetchJson(url);
  const btcRow = json.aaData?.find((r) => r[0] === 'BTC');
  if (!btcRow) throw new Error('BTC row not found in BlackRock holdings data');

  const marketValue = btcRow[3]?.raw || 0;
  const btcQuantity = btcRow[6]?.raw || 0;

  // We need shares outstanding — not in holdings JSON, estimate from config or fetch separately
  // For now, use a known recent value or derive from market data
  return { btcQuantity, marketValue };
}

/**
 * Calculate total round-trip cost in bps
 */
function totalCostBps(config, ibitPrice) {
  const c = config.costs;
  const cu = config.etf.creationUnitShares;
  const feeBps = (c.creationRedemptionFeeUsd / (cu * ibitPrice)) * 10000;
  const commBps = (c.etfCommissionPerShare / ibitPrice) * 10000;
  return feeBps + commBps + c.btcExecutionBps + c.marketImpactBps * 2 + c.btcSpotSpreadBps;
}

/**
 * Format number with commas
 */
function fmt(n, decimals = 2) {
  return n.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function fmtUsd(n) {
  return '$' + fmt(n);
}

module.exports = { fetchJson, fetchBlackrockHoldings, totalCostBps, fmt, fmtUsd };
