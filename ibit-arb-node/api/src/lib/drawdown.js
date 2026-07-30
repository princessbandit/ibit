// Fetch Historical Bitcoin OHLC Data from Kraken (no API key, US-friendly)
async function fetchBitcoinData() {
    const url = new URL('https://api.kraken.com/0/public/OHLC');
    url.searchParams.set('pair', 'XBTUSD');
    url.searchParams.set('interval', '1'); // 1-minute candles

    let retries = 3;
    while (retries > 0) {
        try {
            const response = await fetch(url, {
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': 'ibit-arb-node/1.0'
                }
            });

            if (!response.ok) {
                throw new Error(`Kraken HTTP ${response.status}`);
            }

            const payload = await response.json();
            if (payload.error && payload.error.length > 0) {
                throw new Error(`Kraken API error: ${payload.error.join(', ')}`);
            }

            const candles = payload.result['XXBTZUSD'];
            return candles.map(c => ({
                time: c[0] * 1000,
                open: parseFloat(c[1]),
                high: parseFloat(c[2]),
                low: parseFloat(c[3]),
                close: parseFloat(c[4])
            }));
        } catch (error) {
            retries -= 1;
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

module.exports = { fetchBitcoinData, calcSMA, calcATR, detectMarketState, calculateMaxDrawdown };
