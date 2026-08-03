/**
 * lib/discord.js
 * Discord notification module for IBIT Arb — sends alerts to a channel or DM.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');

const TOKEN     = process.env.DISCORD_TOKEN;
const USER_ID   = process.env.DISCORD_USER_ID;
const GUILD_ID  = process.env.DISCORD_GUILD_ID;

let client = null;
let ready  = false;
let alertChannelId = null;

async function init() {
    if (client) return;

    client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.DirectMessages,
        ]
    });

    client.once('ready', async () => {
        console.log(`[Discord] Logged in as ${client.user.tag}`);
        ready = true;

        // Find or create #ibit-arb-alerts channel in the guild
        try {
            const guild = await client.guilds.fetch(GUILD_ID);
            const channels = await guild.channels.fetch();
            let channel = channels.find(c => c.name === 'ibit-arb-alerts' && c.isTextBased());
            if (!channel) {
                channel = await guild.channels.create({
                    name: 'ibit-arb-alerts',
                    topic: 'IBIT Arbitrage signals, drawdown alerts, and NAV close window notifications',
                });
                console.log(`[Discord] Created #ibit-arb-alerts channel`);
            }
            alertChannelId = channel.id;
            console.log(`[Discord] Alert channel: #${channel.name} (${channel.id})`);

            // Send startup message
            await channel.send({
                embeds: [new EmbedBuilder()
                    .setColor(0x3fb950)
                    .setTitle('🟢 IBIT Arb Bot Online')
                    .setDescription('Dashboard is live. Monitoring arb signals and drawdowns.')
                    .setTimestamp()
                ]
            });
        } catch (e) {
            console.error(`[Discord] Channel setup error: ${e.message}`);
        }
    });

    client.on('error', e => console.error(`[Discord] Error: ${e.message}`));

    await client.login(TOKEN);
}

async function getChannel() {
    if (!ready || !alertChannelId) return null;
    try {
        return await client.channels.fetch(alertChannelId);
    } catch {
        return null;
    }
}

// Send a trade/arb signal alert
async function sendTradeAlert(trade) {
    const channel = await getChannel();
    if (!channel) return;

    const isCreate = trade.signal === 'CREATE';
    const color    = isCreate ? 0x3fb950 : 0xf85149;
    const emoji    = isCreate ? '🟢' : '🔴';

    const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle(`${emoji} ARB SIGNAL — ${trade.signal}`)
        .addFields(
            { name: 'IBIT Price',    value: `$${trade.ibitPrice.toFixed(4)}`,    inline: true },
            { name: 'BTC Price',     value: `$${trade.btcPrice.toFixed(2)}`,     inline: true },
            { name: 'NAV Estimate',  value: `$${trade.navEstimate.toFixed(4)}`,  inline: true },
            { name: 'Spread (bps)',  value: `${trade.spreadBps.toFixed(2)} bps`, inline: true },
            { name: 'Est. PnL',      value: `$${trade.pnl.toFixed(2)}`,          inline: true },
        )
        .setTimestamp(new Date(trade.timestamp))
        .setFooter({ text: 'IBIT Arb Dashboard' });

    await channel.send({ embeds: [embed] });
}

// Send a drawdown alert
async function sendDrawdownAlert({ maxDrawdown, startTime, endTime, triggerState, closingWindow }) {
    const channel = await getChannel();
    if (!channel) return;

    const pct   = parseFloat(maxDrawdown);
    const color = pct < 1 ? 0x3fb950 : pct < 3 ? 0xd29922 : 0xf85149;
    const severity = pct < 1 ? '🟢 Calm' : pct < 3 ? '🟡 Moderate' : '🔴 Severe';

    const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle(`📉 BTC Max 5-Min Drawdown — ${maxDrawdown}`)
        .addFields(
            { name: 'Severity',      value: severity,                                       inline: true },
            { name: 'Regime',        value: triggerState || 'N/A',                          inline: true },
            { name: 'Started',       value: startTime ? new Date(startTime).toLocaleTimeString('en-US', { timeZone: 'America/New_York' }) + ' ET' : 'N/A', inline: true },
            { name: 'Ended',         value: endTime   ? new Date(endTime).toLocaleTimeString('en-US',   { timeZone: 'America/New_York' }) + ' ET' : 'N/A', inline: true },
        )
        .setTimestamp()
        .setFooter({ text: 'IBIT Arb — Drawdown Monitor' });

    // Add closing window summary if available
    if (closingWindow && closingWindow.length > 0) {
        const maxClose = Math.max(...closingWindow.map(d => d.value));
        embed.addFields({
            name: '⏰ Close Window (3:55–4:00 PM ET)',
            value: `Max DD in window: **${maxClose.toFixed(4)}%** across ${closingWindow.length} candles`,
            inline: false
        });
    }

    await channel.send({ embeds: [embed] });
}

// Send a plain text message or DM to the configured user
async function sendDM(message) {
    if (!ready) return;
    try {
        const user = await client.users.fetch(USER_ID);
        await user.send(message);
    } catch (e) {
        console.error(`[Discord] DM error: ${e.message}`);
    }
}

module.exports = { init, sendTradeAlert, sendDrawdownAlert, sendDM };
