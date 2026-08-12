require("dotenv").config();
const axios = require("axios");
const crypto = require("crypto");

const API_KEY = process.env.API_KEY;
const API_SECRET = process.env.API_SECRET;
const URL = process.env.BYBIT_BASE_URL || 'https://api.bybit.com';

const RECV_WINDOW = 5000;
let timeOffset = 0;

async function syncServerTime() {
  try {
    const response = await axios.get(`${URL}/v3/public/time`);
    const serverTime = parseFloat(response.data.result.timeNano) / 1e6;
    timeOffset = Math.round(serverTime - Date.now());
    console.log(`⏰ Server time sync: offset = ${timeOffset}ms`);
  } catch (err) {
    console.error("⚠️  Could not sync server time, using local time");
    timeOffset = 0;
  }
}

function getServerTime() {
  return Date.now() + timeOffset;
}

function buildQuery(params) {
  return Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, val]) => `${key}=${encodeURIComponent(val)}`)
    .join("&");
}

function sign(params) {
  const query = buildQuery(params);
  const sig = crypto.createHmac("sha256", API_SECRET).update(query).digest("hex");
  return `${query}&sign=${sig}`;
}

async function check() {
  const timestamp = Math.floor(getServerTime());
  const balanceParams = {
    api_key: API_KEY,
    coin: 'USDT',
    accountType: 'UNIFIED',
    timestamp,
    recv_window: RECV_WINDOW
  };
  const balanceQuery = sign(balanceParams);

  const { data: bal } = await axios.get(`${URL}/v5/account/wallet-balance?${balanceQuery}`);
  const balanceResult = bal.result?.find(x => x.coin === "USDT") || bal.result;
  console.log("💰 Futures balance:", balanceResult);

  const { data: exInfo } = await axios.get(`${URL}/v2/public/symbols`);
  const btc = exInfo.result.find(s => s.name === "BTCUSDT");
  const lotSize = btc?.price_filter || {};
  console.log("📊 BTCUSDT minQty:", lotSize.min_trading_qty ?? 'N/A');
  console.log("📊 BTCUSDT minNotional:", lotSize.min_trading_qty ? `${lotSize.min_trading_qty} qty` : 'N/A');

  console.log("✅ Done. Now you'll know if Bybit blocks you due to min qty or min notional.");
}

(async () => {
  await syncServerTime();
  await check();
})();
