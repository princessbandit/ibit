# IBIT ETF Arbitrage Simulator (Node.js)

Real-time creation/redemption arbitrage analysis for iShares Bitcoin Trust (IBIT).
:"
>?
## Data Sources
- **BlackRock iShares** — IBIT holdings (BTC quantity, shares outstanding)
- **Yahoo Finance** — Historical IBIT prices & real-time quotes
- **Binance WebSocket** — Real-time BTC/USDT price feed

## Phase 1: Historical Analysis

Analyzes historical premium/discount and models arb P&L.

```bash
npm install
node analyze.js
```

**Outputs:**
- Console: full summary with cost breakdown, opportunity count, P&L analysis, monthly breakdown
- `analysis.csv` — daily data with signals and P&L

## Phase 2: Live Monitor

Real-time dashboard monitoring IBIT premium/discount.

```bash
node monitor.js              # Live (Binance + Yahoo + BlackRock)
node monitor.js --dry-run    # Simulated prices (no external deps)
```

**Outputs:**
- Live console dashboard (refreshes every 5s)
- `trades.csv` — log of simulated arb trades

## Configuration

Edit `config.json` to adjust:
- Cost assumptions (fees, commissions, market impact)
- Signal thresholds (minimum spread after costs)
- BlackRock holdings URL
- Binance WebSocket endpoint

## How the IBIT Arb Works

IBIT is a **cash-create/redeem** spot Bitcoin ETF:

- **Premium (CREATE):** IBIT trades above NAV → Short IBIT + Buy BTC hedge → Create new shares via AP → Cover short
- **Discount (REDEEM):** IBIT trades below NAV → Buy cheap IBIT + Short BTC → Redeem for cash → Cover BTC

The monitor tracks the premium/discount in real-time and signals when it exceeds transaction costs + minimum threshold.

## Web Dashboard

Full real-time web UI with charts, signals, and trade log.

```bash
node dashboard.js              # Live
node dashboard.js --dry-run    # Simulated
node dashboard.js --port 8080  # Custom port
```

Open http://localhost:3000 — features:
- Real-time premium/discount chart (Socket.IO)
- IBIT price, BTC price, NAV estimate
- Signal indicator (NEUTRAL / CREATE / REDEEM)
- Session P&L and trade count
- BlackRock holdings panel
- Cost model breakdown
- Trade log table

## Architecture

```
analyze.js       — Phase 1: Historical backtest
monitor.js       — Phase 2: CLI live monitor
dashboard.js     — Phase 2: Web dashboard (Express + Socket.IO)
public/index.html — Dashboard UI
lib/utils.js     — Shared: BlackRock API, cost model, formatting
config.json      — All tunable parameters
```
