require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');
const API_KEY = process.env.API_KEY;
const API_SECRET = process.env.API_SECRET;
const BYBIT_URL = process.env.BYBIT_BASE_URL || 'https://api.bybit.com';
const RECV_WINDOW = 5000;
let timeOffset = 0;
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
async function syncServerTime() {
  try {
    const response = await axios.get(`${BYBIT_URL}/v3/public/time`);
    const serverTime = parseFloat(response.data.result.timeNano) / 1e6;
    timeOffset = Math.round(serverTime - Date.now());
    console.log(`⏰ Server time sync: offset = ${timeOffset}ms`);
  } catch (err) {
    console.error('⚠️  Could not sync server time, using local time');
    timeOffset = 0;
  }
}
function getServerTime() {
  return Date.now() + timeOffset;
}
async function bybitRequest(method, path, params = {}) {
  params.api_key = API_KEY;
  params.timestamp = Math.floor(getServerTime());
  params.recv_window = RECV_WINDOW;

  const signature = signParams(params);
  const query = buildQuery(params);
  const url = `${BYBIT_URL}${path}?${query}&sign=${signature}`;

  const config = { method, url };
  if (method.toUpperCase() === 'POST') config.data = {};

  const { data } = await axios(config);
  console.log('raw response data:', JSON.stringify(data, null, 2));
  if (data.ret_code && data.ret_code !== 0) {
    throw new Error(data.ret_msg || JSON.stringify(data));
  }

  return data.result || data;
}

async function getFuturesBalance() {
  try {
    const balanceData = await bybitRequest('GET', '/v5/account/wallet-balance', {
      coin: 'USDT',
      accountType: 'UNIFIED',
    });
    console.log('balanceData object:', JSON.stringify(balanceData, null, 2));
    const account = balanceData.list?.find((acc) => acc.accountType === 'UNIFIED') || balanceData.list?.[0] || balanceData;
    const usdtBalance = account?.coin?.find((c) => c.coin === 'USDT') || account;

    const total = usdtBalance?.equity ?? usdtBalance?.walletBalance ?? account?.totalWalletBalance ?? account?.totalEquity ?? '0';
    const available = usdtBalance?.walletBalance ?? account?.totalAvailableBalance ?? usdtBalance?.available_balance ?? '0';

    console.log('=== Bybit Futures Balance ===');
    console.log(`Total Wallet Balance: ${total} USDT`);
    console.log(`Available Balance:    ${available} USDT`);
    console.log('===============================');
  } catch (err) {
    console.error('❌ Error fetching balance:', err.response?.data || err.message);
  }
}

(async () => {
  await syncServerTime();
  await getFuturesBalance();
})();
