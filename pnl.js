// dailyProfit.js
require("dotenv").config();
const axios = require("axios");
const crypto = require("crypto");
const fs = require("fs");
const chalk = require("chalk");

// === CONFIG ===
const API_KEY = process.env.API_KEY;
const API_SECRET = process.env.API_SECRET;
const BYBIT_URL = process.env.BYBIT_BASE_URL || 'https://api.bybit.com';
const RECV_WINDOW = 5000;

// === Time sync to fix timestamp errors ===
let timeOffset = 0;

async function syncServerTime() {
  try {
    const response = await axios.get(`${BYBIT_URL}/v3/public/time`);
    const serverTime = parseFloat(response.data.result.timeNano) / 1e6;
    timeOffset = Math.round(serverTime - Date.now());
    console.log(chalk.yellow(`⏰ Server time sync: offset = ${timeOffset}ms`));
  } catch (err) {
    console.error(chalk.red("⚠️  Could not sync server time, using local time"));
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

function sign(queryString) {
  return crypto.createHmac("sha256", API_SECRET).update(queryString).digest("hex");
}

async function getFuturesBalance() {
  const timestamp = Math.floor(getServerTime());
  const params = {
    api_key: API_KEY,
    coin: "USDT",
    accountType: "UNIFIED",
    timestamp,
    recv_window: RECV_WINDOW,
  };
  const queryString = buildQuery(params);
  const signature = sign(queryString);

  const res = await axios.get(`${BYBIT_URL}/v5/account/wallet-balance?${queryString}&sign=${signature}`);
  const account = res.data.result?.list?.find((a) => a.accountType === "UNIFIED") || res.data.result?.list?.[0] || res.data.result;
  const usdtBalance = account?.coin?.find((c) => c.coin === "USDT") || account;
  return parseFloat(usdtBalance?.equity ?? usdtBalance?.walletBalance ?? account?.totalWalletBalance ?? 0);
}

async function logDailyProfit() {
  const filePath = "./dailyProfit.json";
  let previous = 0;

  try {
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath));
      previous = data.lastBalance;
    }
  } catch (err) {
    console.error("⚠️ Error reading dailyProfit.json:", err.message);
  }

  const current = await getFuturesBalance();
  const profit = current - previous;

  const now = new Date();
  const dateStr = now.toISOString().split("T")[0];

  if (previous > 0) {
    const color = profit >= 0 ? chalk.green : chalk.red;
    console.log(`📅 ${dateStr} — Daily PnL: ${color(`${profit.toFixed(4)} USDT`)}`);
  } else {
    console.log(`📅 ${dateStr} — First record. Balance: ${current.toFixed(4)} USDT`);
  }

  // Save current balance for next day
  fs.writeFileSync(filePath, JSON.stringify({ lastBalance: current, date: dateStr }, null, 2));
}

(async () => {
  await syncServerTime();
  await logDailyProfit();
})().catch(console.error);
