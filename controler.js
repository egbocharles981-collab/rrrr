require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const dns = require('dns');
const https = require('https');
const { SMA } = require('technicalindicators');

// === CONFIG ===
const API_KEY = process.env.API_KEY;
const API_SECRET = process.env.API_SECRET;
const BYBIT_URL = process.env.BYBIT_BASE_URL || 'https://api.bybit.com';
const LOG_FILE = 'trading-log.txt';
const RECV_WINDOW = 5000;

// === VALIDATION ===
if (!API_KEY || !API_SECRET) {
  console.error('❌ Missing API credentials in .env file');
  process.exit(1);
}

function buildQuery(params) {
  return Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, val]) => `${key}=${encodeURIComponent(val)}`)
    .join('&');
}

function signParams(params) {
  const query = buildQuery(params);
  return crypto.createHmac('sha256', API_SECRET).update(query).digest('hex');
}

function signPostRequest(timestamp, jsonBody) {
  const signStr = `${timestamp}${API_KEY}${RECV_WINDOW}${jsonBody}`;
  return crypto.createHmac('sha256', API_SECRET).update(signStr).digest('hex');
}

function logToFile(message) {
  const time = new Date().toISOString();
  const entry = `[${time}] ${message}\n`;
  fs.appendFileSync(LOG_FILE, entry);
  console.log(entry.trim());
}

function mapIntervalToBybit(interval) {
  const mapping = {
    '1m': '1',
    '5m': '5',
    '15m': '15',
    '30m': '30',
    '1h': '60',
    '4h': '240',
    '1d': 'D',
  };
  return mapping[interval] || interval;
}

async function requestWithRetry(method, url, config = {}, maxAttempts = 3) {
  let attempt = 0;
  let lastErr = null;
  while (attempt < maxAttempts) {
    try {
      attempt += 1;
      if (method.toLowerCase() === 'get') return await axios.get(url, config);
      if (method.toLowerCase() === 'post') return await axios.post(url, config.data || {}, { headers: config.headers || {} });
      return await axios({ method, url, ...config });
    } catch (err) {
      lastErr = err;
      const isNetworkErr = err.code === 'ENOTFOUND' || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'EAI_AGAIN';
      if (isNetworkErr && attempt < maxAttempts) {
        const waitMs = 500 * Math.pow(2, attempt - 1);
        console.warn(`⚠️ Network error (${err.code}). Retry ${attempt}/${maxAttempts} in ${waitMs}ms...`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      // attempt alternate DNS resolution and request by IP as a last resort
      if (isNetworkErr) {
        try {
          const hostname = new URL(url).hostname;
          const resolver = new dns.Resolver();
          resolver.setServers(['8.8.8.8', '1.1.1.1']);
          const addrs = await resolver.resolve4(hostname);
          if (addrs && addrs[0]) {
            const ip = addrs[0];
            const newUrl = url.replace(hostname, ip);
            const headers = config.headers || {};
            headers.Host = hostname;
            const resp = await axios({ url: newUrl, method, data: config.data || {}, headers, httpsAgent: new https.Agent({ servername: hostname }) });
            return resp;
          }
        } catch (altErr) {
          console.error('❌ Alternate DNS fallback failed:', altErr.message || altErr);
        }
      }
      throw err;
    }
  }
  throw lastErr;
}

exports.getCandles = async (req, res) => {
  const symbol = req.query.symbol || 'BTCUSDT';
  const interval = req.query.interval || '5m';

  try {
    logToFile(`🔍 Fetching ${interval} candles for ${symbol}`);

    const response = await requestWithRetry('get', `${BYBIT_URL}/v5/market/kline`, {
      params: { symbol, interval: mapIntervalToBybit(interval), limit: 100 },
    });

    const raw = response.data.result?.list || response.data.result || [];

    if (!raw || raw.length === 0) {
      return res.status(404).json({ error: 'No candle data returned from Bybit' });
    }

    const candles = raw.map((k) => {
      if (Array.isArray(k)) {
        return {
          time: parseInt(k[0], 10),
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
          volume: parseFloat(k[5]),
        };
      }
      return {
        time: parseInt(k.open_time, 10) * 1000,
        open: parseFloat(k.open),
        high: parseFloat(k.high),
        low: parseFloat(k.low),
        close: parseFloat(k.close),
        volume: parseFloat(k.volume),
      };
    });

    const closes = candles.map((c) => c.close);
    const sma5 = SMA.calculate({ period: 5, values: closes });
    const sma10 = SMA.calculate({ period: 10, values: closes });

    const fullData = candles.map((c, i) => ({
      ...c,
      sma5: i >= 4 ? sma5[i - 4] : null,
      sma10: i >= 9 ? sma10[i - 9] : null,
    }));

    logToFile(`✅ Candles + SMA fetched for ${symbol} (${candles.length} entries)`);
    res.json({ symbol, interval, candles: fullData });
  } catch (error) {
    const errMsg = error.response?.data?.ret_msg || error.message;
    logToFile(`❌ Candle Fetch Error: ${errMsg}`);
    res.status(500).json({ error: 'Failed to fetch candle data', details: errMsg });
  }
};

exports.executeTrade = async (req, res) => {
  const { action, quantity, symbol } = req.body;

  if (!action || !quantity || !symbol) {
    const msg = 'Missing required fields: action, quantity, or symbol';
    logToFile(`⚠️ ${msg}`);
    return res.status(400).json({ error: msg });
  }

  const side = action.toUpperCase() === 'BUY' ? 'Buy' : 'Sell';
  const fixedQty = parseFloat(quantity).toFixed(6);
  const timestamp = Date.now();

  const params = {
    category: "linear",
    symbol,
    side,
    orderType: 'Market',
    qty: fixedQty,
  };

  // Build auth params for signature
  const jsonBody = JSON.stringify(params);
  const signature = signPostRequest(timestamp, jsonBody);

  logToFile(`🔁 Trade Request: ${side} ${fixedQty} ${symbol}`);

  try {
    const resp = await requestWithRetry('post', `${BYBIT_URL}/v5/order/create`, {
      data: params,
      headers: {
        'Content-Type': 'application/json',
        'X-BAPI-API-KEY': API_KEY,
        'X-BAPI-TIMESTAMP': timestamp,
        'X-BAPI-RECV-WINDOW': RECV_WINDOW,
        'X-BAPI-SIGN': signature,
      },
    });
    const { data } = resp;

    if (data.retCode && data.retCode !== 0) {
      throw new Error(data.retMsg || JSON.stringify(data));
    }

    logToFile(`✅ Trade SUCCESS: ${side} ${fixedQty} ${symbol}`);
    res.json({ message: 'Trade executed successfully', data: data.result });
  } catch (error) {
    const errMsg = error.response?.data || error.message;
    logToFile(`❌ Trade ERROR: ${JSON.stringify(errMsg)}`);
    res.status(500).json({
      error: 'Trade failed',
      reason: error.response?.data?.retMsg || error.message || 'Unknown error',
      bybitError: error.response?.data || null,
    });
  }
};
