// === closeAllTrades.js ===
// Close all open positions immediately
require("dotenv").config();
const axios = require("axios");
const crypto = require("crypto");
const chalk = require("chalk");
const dns = require('dns');
const https = require('https');

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

function signParams(params, timestamp = null) {
  const query = buildQuery(params);
  const signStr = timestamp ? `${timestamp}${API_KEY}${RECV_WINDOW}${query}` : query;
  return crypto.createHmac("sha256", API_SECRET).update(signStr).digest("hex");
}

function signPostRequest(timestamp, jsonBody) {
  const signStr = `${timestamp}${API_KEY}${RECV_WINDOW}${jsonBody}`;
  return crypto.createHmac("sha256", API_SECRET).update(signStr).digest("hex");
}

async function bybitRequest(method, path, params = {}) {
  const maxAttempts = 3;
  let attempt = 0;
  let lastErr = null;

  while (attempt < maxAttempts) {
    try {
      attempt += 1;
      const timestamp = Math.floor(getServerTime());
      const axiosConfig = {
        method,
        url: `${BYBIT_URL}${path}`,
        headers: {
          "X-BAPI-API-KEY": API_KEY,
          "X-BAPI-TIMESTAMP": timestamp,
          "X-BAPI-RECV-WINDOW": RECV_WINDOW,
        },
      };

      // For POST, send params in body and sign with timestamp+api_key+recv_window+body format
      if (method.toUpperCase() === "POST") {
        axiosConfig.data = params;
        const jsonBody = JSON.stringify(params);
        axiosConfig.headers["Content-Type"] = "application/json";
        axiosConfig.headers["X-BAPI-SIGN"] = signPostRequest(timestamp, jsonBody);
      } else {
        // For GET, use query params with sorted query string signature
        const authParams = {
          api_key: API_KEY,
          timestamp,
          recv_window: RECV_WINDOW,
          ...params,
        };
        const query = buildQuery(authParams);
        axiosConfig.url += `?${query}`;
        axiosConfig.headers["X-BAPI-SIGN"] = signParams(authParams, timestamp);
      }

      const { data } = await axios(axiosConfig);
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
        await sleep(waitMs);
        continue;
      }

      // fallback: alternate DNS and request by IP
      if (isNetworkErr) {
        try {
          const hostname = new URL(`${BYBIT_URL}${path}`).hostname;
          const resolver = new dns.Resolver();
          resolver.setServers(['8.8.8.8', '1.1.1.1']);
          const addrs = await resolver.resolve4(hostname);
          if (addrs && addrs[0]) {
            const ip = addrs[0];
            const newUrl = `${BYBIT_URL}${path}`.replace(hostname, ip);
            axiosConfig.headers = axiosConfig.headers || {};
            axiosConfig.headers.Host = hostname;
            axiosConfig.httpsAgent = new https.Agent({ servername: hostname });
            const resp = await axios({ url: newUrl, method: axiosConfig.method, data: axiosConfig.data || {}, headers: axiosConfig.headers, httpsAgent: axiosConfig.httpsAgent });
            const altData = resp.data;
            if (altData.retCode && altData.retCode !== 0) throw new Error(altData.retMsg || JSON.stringify(altData));
            return altData.result || altData;
          }
        } catch (alt) {
          console.error('❌ Alternate DNS fallback failed:', alt.message || alt);
        }
      }
      console.error("❌ Bybit API error:", err.response?.data || err.message);
      throw err;
    }
  }
  throw lastErr;
}

// === Cancel all open orders ===
async function cancelAllOrders() {
  try {
    const positions = await bybitRequest("GET", "/v5/position/list", { category: "linear", settleCoin: "USDT" });
    const openPositions = (Array.isArray(positions) ? positions : [positions]).filter((p) => Math.abs(parseFloat(p.size || 0)) > 0);

    if (openPositions.length === 0) {
      console.log(chalk.yellow("⚠️  No open positions found"));
      return;
    }

    const symbols = [...new Set(openPositions.map((pos) => pos.symbol))];
    for (const symbol of symbols) {
      try {
        await bybitRequest("POST", "/v5/order/cancel-all", { category: "linear", symbol });
        console.log(chalk.yellow(`🧹 Cancelled open orders for ${symbol}`));
      } catch (e) {
        console.error(chalk.red(`❌ Failed to cancel orders for ${symbol}:`, e.message));
      }
    }
  } catch (err) {
    console.error(chalk.red("❌ Error cancelling orders:", err.message));
  }
}

// === Close all open positions ===
async function closeAllPositions() {
  try {
    console.log(chalk.cyan("\n🔄 Fetching open positions..."));
    
    const positions = await bybitRequest("GET", "/v5/position/list", { category: "linear", settleCoin: "USDT" });
    const openPositions = (Array.isArray(positions) ? positions : [positions]).filter((p) => Math.abs(parseFloat(p.size || 0)) > 0);

    if (openPositions.length === 0) {
      console.log(chalk.green("✅ No open positions to close"));
      return;
    }

    console.log(chalk.cyan(`\n📊 Found ${openPositions.length} open position(s):\n`));

    for (const pos of openPositions) {
      const symbol = pos.symbol;
      const positionAmount = parseFloat(pos.size || 0);
      const entryPrice = parseFloat(pos.entry_price || 0);
      const unrealizedProfit = parseFloat(pos.unrealised_pnl || pos.unrealized_pnl || 0);
      const closingSide = positionAmount > 0 ? "Sell" : "Buy";
      const quantity = Math.abs(positionAmount);

      console.log(chalk.blue(`  📍 ${symbol}`));
      console.log(chalk.gray(`     Position: ${positionAmount > 0 ? "LONG" : "SHORT"} | Amount: ${quantity}`));
      console.log(chalk.gray(`     Entry: ${entryPrice.toFixed(4)} | Quantity: ${quantity}`));
      console.log(chalk.gray(`     Unrealized P&L: ${unrealizedProfit.toFixed(2)} USDT`));

      try {
        console.log(chalk.yellow(`    ⏳ Closing with ${closingSide} market order...`));
        
        const orderResult = await bybitRequest("POST", "/v5/order/create", {
          category: "linear",
          symbol: symbol,
          side: closingSide,
          orderType: "Market",
          qty: String(quantity),
          reduceOnly: true,
        });

        console.log(chalk.green(`    ✅ ${symbol} CLOSED successfully`));
        console.log(chalk.gray(`       Order ID: ${orderResult.orderId || orderResult.order_id}\n`));
      } catch (err) {
        console.error(chalk.red(`    ❌ Failed to close ${symbol}:`, err.message));
      }
    }

    console.log(chalk.cyan("\n✨ All positions closed!"));
  } catch (err) {
    console.error(chalk.red("❌ Error closing positions:", err.message));
  }
}

// === Main execution ===
async function main() {
  console.log(chalk.inverse.bold(" 🛑 CLOSE ALL TRADES 🛑 "));
  console.log(chalk.yellow("\n⚠️  This will close ALL open positions immediately!\n"));

  try {
    // 0️⃣ Sync with server time first
    await syncServerTime();

    // 1️⃣ Cancel all open orders first
    await cancelAllOrders();

    // 2️⃣ Close all positions
    await closeAllPositions();

    console.log(chalk.green("\n✅ Process completed"));
  } catch (err) {
    console.error(chalk.red("\n❌ Fatal error:", err.message));
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = { closeAllPositions, cancelAllOrders };
