require("dotenv").config();
const axios = require("axios");
const crypto = require("crypto");
const dns = require('dns');
const https = require('https');
const { buildSlTpOrders } = require('./sltp');

const API_KEY = process.env.API_KEY;
const API_SECRET = process.env.API_SECRET;
const BYBIT_URL = process.env.BYBIT_BASE_URL || 'https://api.bybit.com';

const SYMBOL = "BTCUSDT";
const SIDE = "BUY";      // change to "Sell" to test short
const LEVERAGE = 100;
const QUANTITY = 0.001;  // start small
const RECV_WINDOW = 5000;
let timeOffset = 0;

function buildQuery(params) {
  return Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, val]) => `${key}=${encodeURIComponent(val)}`)
    .join("&");
}

function signParams(params, timestamp = null) {
  const queryString = buildQuery(params);
  const signStr = timestamp ? `${timestamp}${API_KEY}${RECV_WINDOW}${queryString}` : queryString;
  return crypto
    .createHmac("sha256", API_SECRET)
    .update(signStr)
    .digest("hex");
}

function signPostRequest(timestamp, jsonBody) {
  const signStr = `${timestamp}${API_KEY}${RECV_WINDOW}${jsonBody}`;
  return crypto
    .createHmac("sha256", API_SECRET)
    .update(signStr)
    .digest("hex");
}

function getServerTime() {
  return Date.now() + timeOffset;
}

async function syncServerTime() {
  try {
    const response = await axios.get(`${BYBIT_URL}/v3/public/time`);
    const serverTime = parseFloat(response.data.result.timeNano) / 1e6;
    timeOffset = Math.round(serverTime - Date.now());
    console.log(`⏰ Server time sync: offset = ${timeOffset}ms`);
  } catch (err) {
    console.error("⚠️  Could not sync server time, using local time");
    timeOffset = 0;
  }
}

async function bybitRequest(method, path, params = {}) {
  const maxAttempts = 3;
  let attempt = 0;
  let lastErr = null;

  while (attempt < maxAttempts) {
    try {
      attempt += 1;
      const timestamp = Math.floor(getServerTime());
      const config = {
        method,
        url: `${BYBIT_URL}${path}`,
        headers: {
          "X-BAPI-API-KEY": API_KEY,
          "X-BAPI-TIMESTAMP": timestamp,
          "X-BAPI-RECV-WINDOW": RECV_WINDOW,
        },
      };

      if (method.toUpperCase() === "POST") {
        config.data = params;
        const jsonBody = JSON.stringify(params);
        config.headers["Content-Type"] = "application/json";
        config.headers["X-BAPI-SIGN"] = signPostRequest(timestamp, jsonBody);
      } else {
        const authParams = {
          api_key: API_KEY,
          timestamp,
          recv_window: RECV_WINDOW,
          ...params,
        };
        const query = buildQuery(authParams);
        config.url += `?${query}`;
        config.headers["X-BAPI-SIGN"] = signParams(authParams, timestamp);
      }

      const { data } = await axios(config);
      if (data.retCode && data.retCode !== 0) {
        throw new Error(data.retMsg || JSON.stringify(data));
      }
      return data.result || data;
    } catch (err) {
      lastErr = err;
      const isNetworkErr = err.code === 'ENOTFOUND' || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'EAI_AGAIN';
      if (isNetworkErr && attempt < maxAttempts) {
        const waitMs = 500 * Math.pow(2, attempt - 1);
        console.warn(`⚠️ Network error (${err.code}). Retry ${attempt}/${maxAttempts} in ${waitMs}ms...`);
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      // try alternate DNS then request by IP
      if (isNetworkErr) {
        try {
          const resolver = new dns.Resolver();
          resolver.setServers(['8.8.8.8', '1.1.1.1']);
          const addrs = await resolver.resolve4(new URL(`${BYBIT_URL}${path}`).hostname);
          const ip = addrs && addrs[0];
          if (ip) {
            const newUrl = `${BYBIT_URL}${path}`.replace(new URL(`${BYBIT_URL}${path}`).hostname, ip);
            const headers = {
              Host: new URL(`${BYBIT_URL}${path}`).hostname,
              "X-BAPI-API-KEY": API_KEY,
              "X-BAPI-TIMESTAMP": timestamp,
              "X-BAPI-RECV-WINDOW": RECV_WINDOW,
            };
            if (method.toUpperCase() === 'POST') headers['X-BAPI-SIGN'] = signPostRequest(timestamp, JSON.stringify(params));
            const resp = await axios({ url: newUrl, method, data: method.toUpperCase() === 'POST' ? params : undefined, headers, httpsAgent: new https.Agent({ servername: new URL(`${BYBIT_URL}${path}`).hostname }) });
            const altData = resp.data;
            if (altData.retCode && altData.retCode !== 0) throw new Error(altData.retMsg || JSON.stringify(altData));
            return altData.result || altData;
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

async function setLeverage() {
  try {
    const res = await bybitRequest("POST", "/v5/position/set-leverage", {
      category: "linear",
      symbol: SYMBOL,
      buyLeverage: String(LEVERAGE),
      sellLeverage: String(LEVERAGE),
    });
    console.log(`✅ Leverage set to ${LEVERAGE}x`, res);
  } catch (err) {
    console.log("❌ Leverage error:", err.response?.data || err.message);
  }
}

async function placeOrder() {
  try {
    const res = await bybitRequest("POST", "/v5/order/create", {
      category: "linear",
      symbol: SYMBOL,
      side: SIDE,
      orderType: "Market",
      qty: String(QUANTITY),
    });

    console.log(`✅ ${SIDE} order successful!`);
    console.log(res);

    await new Promise((resolve) => setTimeout(resolve, 5000));
    await placeTpSlForRecentTrade();
  } catch (err) {
    console.log(`❌ ${SIDE} order failed:`, err.response?.data || err.message);
  }
}

async function placeTpSlForRecentTrade() {
  try {
    let entryPrice = 0;
    let qty = 0;
    let lastRawPosition = null;

    for (let attempt = 1; attempt <= 12; attempt += 1) {
      const positionInfo = await bybitRequest("GET", "/v5/position/list", {
        category: "linear",
        symbol: SYMBOL,
        settleCoin: "USDT",
      });

      const position = Array.isArray(positionInfo)
        ? positionInfo.find((p) => p.symbol === SYMBOL)
        : positionInfo?.list?.find((p) => p.symbol === SYMBOL) || positionInfo?.list?.[0] || positionInfo;

      lastRawPosition = position;
      entryPrice = Number(position?.entry_price || 0);
      qty = Math.abs(Number(position?.size || position?.pos_qty || 0));

      if (entryPrice > 0 && qty > 0) {
        break;
      }

      console.log(`⏳ Waiting for trade fill before placing TP/SL (${attempt}/12)...`);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }

    if (!entryPrice || qty <= 0) {
      console.log('⚠️ Trade never filled. No SL/TP order placed. Raw position:', lastRawPosition);
      return;
    }

    const orderSet = buildSlTpOrders({
      side: SIDE,
      entryPrice,
      qty,
      tpPercent: 0.015,
      slPercent: 0.007,
      symbol: SYMBOL,
    });

    console.log(`🎯 TP: ${orderSet.tp} | 🛑 SL: ${orderSet.sl}`);

    const tpRes = await bybitRequest("POST", "/v5/order/create", orderSet.tpOrder);
    const slRes = await bybitRequest("POST", "/v5/order/create", orderSet.slOrder);

    console.log('✅ TP order placed:', tpRes);
    console.log('✅ SL order placed:', slRes);
  } catch (err) {
    console.log('❌ Failed to place TP/SL orders:', err.response?.data || err.message);
  }
}

(async () => {
  console.log(`🚀 Forcing trade: ${SIDE} on ${SYMBOL}`);
  await syncServerTime();
  await setLeverage();
  await placeOrder();
})();
