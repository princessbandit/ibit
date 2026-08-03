const { app } = require('@azure/functions');
const { fetchBitcoinData, calculateMaxDrawdown } = require('../lib/drawdown');

app.http('drawdownData', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'drawdown/data',
    handler: async (request, context) => {
        try {
            const data = await fetchBitcoinData();
            const { maxDrawdown, maxDrawdownStart, maxDrawdownEnd, maxDrawdownState, drawdowns, stateLabels } = calculateMaxDrawdown(data);
            const drawdownValues = drawdowns.map(d => d.value);
            const stateCounts = stateLabels.reduce((acc, s) => { acc[s] = (acc[s] || 0) + 1; return acc; }, {});

            // Filter 3:55 PM - 4:00 PM ET window (20:55 - 21:00 UTC)
            const closingWindow = drawdowns.filter(d => {
                const date = new Date(d.time);
                const utcH = date.getUTCHours();
                const utcM = date.getUTCMinutes();
                return (utcH === 20 && utcM >= 55) || (utcH === 21 && utcM === 0);
            });

            const body = {
                maxDrawdown: `${maxDrawdown.toFixed(4)}%`,
                startTime: maxDrawdownStart ? new Date(maxDrawdownStart).toISOString() : null,
                endTime: maxDrawdownEnd ? new Date(maxDrawdownEnd).toISOString() : null,
                triggerState: maxDrawdownState || 'No LOW_VOL_BULL periods found',
                stateCounts,
                dataPoints: drawdowns.length,
                drawdowns: drawdownValues,
                stateLabels,
                closingWindow
            };

            return { jsonBody: body };
        } catch (err) {
            context.error(`[drawdownData] ${err.message}`);
            return { status: 500, jsonBody: { error: err.message } };
        }
    }
});
