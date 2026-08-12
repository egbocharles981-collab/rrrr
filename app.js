require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 5000;

const BYBIT_BASE_URL = process.env.BYBIT_BASE_URL || 'https://api.bybit.com';

// ===== MIDDLEWARE =====
app.use(cors()); // ✅ Enable CORS for all origins
app.use(express.static('public')); // Serve frontend files
app.use(express.json()); // Parse JSON body

// ===== ROUTES =====
// ✅ If you later add routes in /routes/candleRoutes.js, uncomment this
// const candleRoutes = require('./routes/candleRoutes');
// app.use('/api', candleRoutes);

// ✅ Get latest 5m candlestick from Bybit
function mapIntervalToBybit(interval) {
    const map = {
        '1m': '1',
        '5m': '5',
        '15m': '15',
        '30m': '30',
        '1h': '60',
        '4h': '240',
        '1d': 'D'
    };
    return map[interval] || interval;
}

app.get('/api/candle', async (req, res) => {
    const symbol = req.query.symbol?.toUpperCase() || 'BTCUSDT';
    const interval = req.query.interval || '5m';

    try {
        const response = await axios.get(`${BYBIT_BASE_URL}/v5/market/kline`, {
            params: { symbol, interval: mapIntervalToBybit(interval), limit: 100 }
        });

        const raw = response.data.result?.list || response.data.result || [];
        if (!raw || !Array.isArray(raw) || raw.length === 0) {
            return res.status(400).json({ error: 'No candlestick data returned from Bybit' });
        }

        const candles = raw.map(c => {
            if (Array.isArray(c)) {
                return {
                    x: new Date(parseInt(c[0], 10)).toISOString(),
                    o: parseFloat(c[1]),
                    h: parseFloat(c[2]),
                    l: parseFloat(c[3]),
                    c: parseFloat(c[4]),
                    v: parseFloat(c[5])
                };
            }
            return {
                x: new Date(c.open_time * 1000).toISOString(),
                o: parseFloat(c.open),
                h: parseFloat(c.high),
                l: parseFloat(c.low),
                c: parseFloat(c.close),
                v: parseFloat(c.volume)
            };
        });

        console.log('Sending candles:', candles.slice(0, 2));
        return res.json({ candles });

    } catch (err) {
        console.error('❌ Error fetching candlestick:', err.response?.data || err.message);
        return res.status(500).json({ error: 'Failed to fetch candlestick data' });
    }
});

// ✅ Execute a market trade
function buildQuery(params) {
    return Object.entries(params)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, val]) => `${key}=${encodeURIComponent(val)}`)
        .join('&');
}

function signParams(params, secret) {
    const queryString = buildQuery(params);
    return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
}

app.post('/api/trade', async (req, res) => {
    const { action, symbol, quantity } = req.body;

    if (!action || !symbol || !quantity) {
        return res.status(400).json({ error: 'Missing required fields: action, symbol, or quantity' });
    }

    const API_KEY = process.env.API_KEY;
    const API_SECRET = process.env.API_SECRET;

    if (!API_KEY || !API_SECRET) {
        return res.status(500).json({ error: 'Missing API credentials' });
    }

    try {
        const side = action.toUpperCase() === 'BUY' ? 'Buy' : 'Sell';
        const params = {
            api_key: API_KEY,
            symbol,
            side,
            order_type: 'Market',
            qty: quantity.toString(),
            time_in_force: 'GoodTillCancel',
            reduce_only: false,
            close_on_trigger: false,
            timestamp: Date.now(),
            recv_window: 5000
        };

        const signature = signParams(params, API_SECRET);
        const url = `${BYBIT_BASE_URL}/v5/order/create?${buildQuery(params)}&sign=${signature}`;

        const response = await axios.post(url, {}, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });

        if (response.data.ret_code && response.data.ret_code !== 0) {
            throw new Error(response.data.ret_msg || JSON.stringify(response.data));
        }

        res.json({
            success: true,
            orderId: response.data.result.order_id,
            side: response.data.result.side,
            executedQty: response.data.result.qty,
            price: response.data.result.price || 'Market Price'
        });

    } catch (err) {
        console.error('❌ Trade error:', err.response?.data || err.message);
        res.status(500).json({ error: err.response?.data || err.message });
    }
});

// ===== HEALTH CHECK (OPTIONAL) =====
app.get('/', (req, res) => {
    res.send('✅ AutoPatoBot server is running');
});

// ===== START SERVER =====
app.listen(port, () => {
    console.log(`✅ Server is live on port ${port}`);
    console.log(`🌐 Visit on Render: https://autopatobot.onrender.com`);
});