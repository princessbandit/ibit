const axios = require('axios');
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');
const fs = require('fs');

// Fetch Historical Bitcoin Data from Kraken (no API key, US-friendly)
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
            if (retries === 0) throw new Error(`Failed to fetch data after 3 retries: ${error.message}`);
            await new Promise(resolve => setTimeout(resolve, 3000));
        }
    }
}

// Compute Maximum Drawdown within 10 Minutes
function calculateMaxDrawdown(data) {
    let maxDrawdown = 0;
    let startTime = null;
    const drawdowns = [];

    for (let i = 0; i < data.length - 10; i++) {
        const initialPrice = data[i].close;
        const tenMinuteSlice = data.slice(i, i + 10);
        const minPrice = Math.min(...tenMinuteSlice.map(candle => candle.low));
        const drawdown = ((initialPrice - minPrice) / initialPrice) * 100;

        drawdowns.push(drawdown);

        if (drawdown > maxDrawdown) {
            maxDrawdown = drawdown;
            startTime = data[i].time;
        }
    }
    return { maxDrawdown, startTime, drawdowns };
}

// Generate Chart
async function generateChart(drawdowns) {
    const width = 800;
    const height = 600;
    const chartJSNodeCanvas = new ChartJSNodeCanvas({ width, height });

    const chartConfig = {
        type: 'line',
        data: {
            labels: drawdowns.map((_, index) => index),
            datasets: [
                {
                    label: 'BTC 10-min Drawdown (%)',
                    data: drawdowns,
                    borderColor: 'rgb(255, 99, 132)',
                    backgroundColor: 'rgba(255, 99, 132, 0.1)',
                    fill: true,
                    tension: 0.2,
                    pointRadius: 0,
                },
            ],
        },
        options: {
            scales: {
                x: {
                    title: { display: true, text: 'Time (Minute Index)' },
                },
                y: {
                    title: { display: true, text: 'Drawdown (%)' },
                },
            },
        },
    };

    const imageBuffer = await chartJSNodeCanvas.renderToBuffer(chartConfig);
    fs.writeFileSync('drawdown_chart.png', imageBuffer);
    console.log('Chart saved as drawdown_chart.png');
}

// Main Function
(async () => {
    try {
        console.log("Fetching Bitcoin data from CoinGecko...");
        const data = await fetchBitcoinData();

        console.log("Calculating maximum drawdown...");
        const { maxDrawdown, startTime, drawdowns } = calculateMaxDrawdown(data);

        console.log(`Max Drawdown: ${maxDrawdown.toFixed(4)}%`);
        console.log(`Occurred at: ${new Date(startTime).toISOString()}`);

        console.log("Generating chart...");
        await generateChart(drawdowns);
    } catch (err) {
        console.error(err.message);
    }
})();