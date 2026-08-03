require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');
const axios = require('axios');
const discord = require('./lib/discord');

const app = express();
const PORT = 4000;
const PUBLIC_DIR = path.join(__dirname, 'drawdown-public');

// Fetch Historical Bitcoin OHLC Data from Kraken (no API key, US-friendly)
async function fetchBitcoinData() {
    const API_URL = "https://api.kraken.com/0/public/OHLC";
    const params = {
        pair: 'XBTUSD',
        interval: 1   // 1-minute candles
    };

    let retries = 3;
    while (retries > 0) {
        try {
            const response = await axios.get(API_URL, {
                params,
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': 'ibit-arb-node/1.0'
                }
            });

            if (response.data.error && response.data.error.length > 0) {
                throw new Error(`Kraken API error: ${response.data.error.join(', ')}`);
            }

            const candles = response.data.result['XXBTZUSD'];
            return candles.map(c => ({
                time: c[0] * 1000,
                open: parseFloat(c[1]),
                high: parseFloat(c[2]),
                low: parseFloat(c[3]),
                close: parseFloat(c[4])
            }));
        } catch (error) {
            retries -= 1;
            const status = error.response ? error.response.status : 'N/A';
            console.log(`[WARN] Fetch failed (status ${status}). Retrying... (${3 - retries}/3)`);
            if (retries === 0) throw new Error(`Failed to fetch data from Kraken after 3 retries. Last error: ${error.message}`);
            await new Promise(resolve => setTimeout(resolve, 3000));
        }
    }
}

// Compute 20-period Simple Moving Average
function calcSMA(data, period = 20) {
    return data.map((_, i) => {
        if (i < period - 1) return null;
        const slice = data.slice(i - period + 1, i + 1);
        return slice.reduce((sum, c) => sum + c.close, 0) / period;
    });
}

// Compute Average True Range (ATR) over a period
function calcATR(data, period = 14) {
    const trueRanges = data.map((c, i) => {
        if (i === 0) return c.high - c.low;
        const prevClose = data[i - 1].close;
        return Math.max(
            c.high - c.low,
            Math.abs(c.high - prevClose),
            Math.abs(c.low - prevClose)
        );
    });
    return trueRanges.map((_, i) => {
        if (i < period - 1) return null;
        return trueRanges.slice(i - period + 1, i + 1).reduce((s, v) => s + v, 0) / period;
    });
}

// Detect Low Volatility Bull Trend state
// Bull Trend: close > SMA20
// Low Volatility: ATR < median ATR of entire dataset
function detectMarketState(data) {
    const sma = calcSMA(data, 20);
    const atr = calcATR(data, 14);

    // Compute median ATR for threshold
    const validATR = atr.filter(v => v !== null);
    const sorted = [...validATR].sort((a, b) => a - b);
    const medianATR = sorted[Math.floor(sorted.length / 2)];

    return data.map((c, i) => {
        if (sma[i] === null || atr[i] === null) return 'INSUFFICIENT_DATA';
        const isBull = c.close > sma[i];
        const isLowVol = atr[i] < medianATR;
        if (isBull && isLowVol) return 'LOW_VOL_BULL';
        if (isBull && !isLowVol) return 'HIGH_VOL_BULL';
        if (!isBull && isLowVol) return 'LOW_VOL_BEAR';
        return 'HIGH_VOL_BEAR';
    });
}

// Compute Maximum Drawdown within 5 Minutes, only from LOW_VOL_BULL state
function calculateMaxDrawdown(data) {
    const states = detectMarketState(data);
    let maxDrawdown = 0;
    let maxDrawdownStart = null;
    let maxDrawdownEnd = null;
    let maxDrawdownState = null;
    const drawdowns = [];
    const stateLabels = [];

    for (let i = 0; i < data.length - 5; i++) {
        const state = states[i];
        stateLabels.push(state);

        if (state !== 'LOW_VOL_BULL') {
            drawdowns.push({ value: 0, time: data[i].time, state });
            continue;
        }

        const initialPrice = data[i].close;
        const fiveMinuteSlice = data.slice(i, i + 5);
        const minPrice = Math.min(...fiveMinuteSlice.map(candle => candle.low));
        const drawdown = ((initialPrice - minPrice) / initialPrice) * 100;

        drawdowns.push({ value: drawdown, time: data[i].time, state, open: initialPrice, low: minPrice });

        if (drawdown > maxDrawdown) {
            maxDrawdown = drawdown;
            maxDrawdownStart = data[i].time;
            maxDrawdownEnd = fiveMinuteSlice[fiveMinuteSlice.length - 1].time;
            maxDrawdownState = state;
        }
    }
    return { maxDrawdown, maxDrawdownStart, maxDrawdownEnd, maxDrawdownState, drawdowns, stateLabels };
}

// Generate Chart and save to disk
async function generateChart(drawdowns, stateLabels) {
    const width = 800;
    const height = 400;
    const chartJSNodeCanvas = new ChartJSNodeCanvas({ width, height, backgroundColour: '#161b22' });

    // Colour points: green = LOW_VOL_BULL, grey = other states
    const pointColors = drawdowns.map((_, i) =>
        stateLabels && stateLabels[i] === 'LOW_VOL_BULL' ? 'rgba(63,185,80,0.8)' : 'rgba(139,148,158,0.3)'
    );

    const chartConfig = {
        type: 'line',
        data: {
            labels: drawdowns.map((_, index) => index),
            datasets: [{
                label: 'Drawdown from Low Vol Bull State (%)',
                data: drawdowns,
                borderColor: 'rgb(255, 99, 132)',
                backgroundColor: 'rgba(255, 99, 132, 0.1)',
                pointBackgroundColor: pointColors,
                fill: true,
                tension: 0.2,
                pointRadius: 2,
                borderWidth: 2
            }],
        },
        options: {
            plugins: { legend: { labels: { color: '#c9d1d9' } } },
            scales: {
                x: { ticks: { color: '#8b949e' }, title: { display: true, text: 'Minute Index', color: '#8b949e' } },
                y: { ticks: { color: '#8b949e' }, title: { display: true, text: 'Drawdown (%)', color: '#8b949e' } }
            }
        },
    };

    const imageBuffer = await chartJSNodeCanvas.renderToBuffer(chartConfig);
    const filePath = path.join(__dirname, 'drawdown_chart.png');
    fs.writeFileSync(filePath, imageBuffer);
    return filePath;
}

// Serve HTML dashboard
app.use(express.static(PUBLIC_DIR));

// Root route → HTML UI
app.get('/', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// JSON data endpoint (used by the UI)
app.get('/drawdown/data', async (req, res) => {
    try {
        console.log("[API] Fetching BTC data from Kraken...");
        const data = await fetchBitcoinData();
        const { maxDrawdown, maxDrawdownStart, maxDrawdownEnd, maxDrawdownState, drawdowns, stateLabels } = calculateMaxDrawdown(data);
        const drawdownValues = drawdowns.map(d => d.value);
        await generateChart(drawdownValues, stateLabels);

        // Count state distribution
        const stateCounts = stateLabels.reduce((acc, s) => { acc[s] = (acc[s] || 0) + 1; return acc; }, {});

        // Filter 3:55 PM - 4:00 PM ET window (20:55 - 21:00 UTC)
        const closingWindow = drawdowns.filter(d => {
            const date = new Date(d.time);
            const utcH = date.getUTCHours();
            const utcM = date.getUTCMinutes();
            return (utcH === 20 && utcM >= 55) || (utcH === 21 && utcM === 0);
        });

        res.json({
            maxDrawdown: `${maxDrawdown.toFixed(4)}%`,
            startTime: maxDrawdownStart ? new Date(maxDrawdownStart).toISOString() : null,
            endTime: maxDrawdownEnd ? new Date(maxDrawdownEnd).toISOString() : null,
            triggerState: maxDrawdownState || 'No LOW_VOL_BULL periods found',
            stateCounts,
            dataPoints: drawdowns.length,
            drawdowns: drawdownValues,
            stateLabels,
            closingWindow,
            chartUrl: `http://localhost:${PORT}/drawdown/chart`
        });

        // Send Discord alert
        discord.sendDrawdownAlert({
            maxDrawdown: `${maxDrawdown.toFixed(4)}%`,
            startTime: maxDrawdownStart,
            endTime: maxDrawdownEnd,
            triggerState: maxDrawdownState,
            closingWindow
        }).catch(() => {});
    } catch (err) {
        console.error(`[API] Error: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

// Legacy JSON endpoint
app.get('/drawdown', async (req, res) => {
    res.redirect('/drawdown/data');
});

// Chart image endpoint
app.get('/drawdown/chart', (req, res) => {
    const filePath = path.join(__dirname, 'drawdown_chart.png');
    if (!fs.existsSync(filePath)) {
        return res.status(404).send('Chart not yet generated. Please call /drawdown/data first.');
    }
    res.sendFile(filePath);
});

// Start the server
app.listen(PORT, async () => {
    console.log(`\n  📉 Drawdown Dashboard running at http://localhost:${PORT}`);
    console.log(`  Endpoints:`);
    console.log(`    GET /               → HTML dashboard`);
    console.log(`    GET /drawdown/data  → JSON stats + drawdowns array`);
    console.log(`    GET /drawdown/chart → chart image\n`);
    await discord.init();
});