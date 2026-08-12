// === autotrader.js ===
require("dotenv").config();
const axios = require("axios");
const crypto = require("crypto");
const dns = require('dns');
const https = require('https');
const { SMA } = require("technicalindicators");
const chalk = require("chalk");
const fs = require("fs");
const {
  buildExitOrderParams: buildSLTPExitOrderParams,
  buildSlTpOrders: buildSLTPOrderSet,
} = require('./sltp');

const API_KEY = process.env.API_KEY;
const API_SECRET = process.env.API_SECRET;
const BYBIT_BASE_URL = process.env.BYBIT_BASE_URL || 'https://api.bybit.com';
const SYMBOL = "BTCUSDT";
const INTERVAL = "1h";
const QUANTITY = 0.001; // Bybit contract qty may differ from Binance; adjust if needed
const LEVERAGE = 50;
const TP_PERCENT = 0.015;
const SL_PERCENT = 0.007;

const INTERVAL_MS = {
  "1m": 60 * 1000,
  "5m": 5 * 60 * 1000,
  "15m": 15 * 60 * 1000,
  "30m": 30 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
};
const CONFIRMATION_WAIT = 2 * 60 * 1000;
const PRICE_PRECISION = 2;
const QTY_PRECISION = 3;
const RECV_WINDOW = 5000;

let timeOffset = 0;
let watcherInterval = null;

let currentPosition = null;
let lastPositionClosedAt = 0;
let lastTradeTime = 0;
let lastConfig = null;

function formatQty(q) {
  const factor = 10 ** QTY_PRECISION;
  return Math.max(0, Math.floor(q * factor) / factor);
}

function formatPrice(p) {
  return parseFloat(p.toFixed(PRICE_PRECISION));
}

function buildExitOrderParams(side, triggerPrice, qty, kind) {
  return buildSLTPExitOrderParams({
    side,
    symbol: SYMBOL,
    triggerPrice,
    qty,
    kind,
    category: "linear",
  });
}

function buildSlTpOrders({ side, entryPrice, qty, tpPercent = TP_PERCENT, slPercent = SL_PERCENT }) {
  return buildSLTPOrderSet({
    side,
    entryPrice,
    qty,
    tpPercent,
    slPercent,
    symbol: SYMBOL,
  });
}

function getServerTime() {
  return Date.now() + timeOffset;
}

function toBybitSide(side) {
  return side === "BUY" ? "Buy" : "Sell";
}

function buildQuery(params) {
  return Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, val]) => `${key}=${encodeURIComponent(val)}`)
    .join("&");
}

function extractTickerFromResponse(data) {
  const result = data?.result;
  if (!result) return null;
  if (Array.isArray(result)) return result[0] || null;
  if (Array.isArray(result.list)) return result.list[0] || null;
  return result;
}

function parseTickerPrice(ticker) {
  if (!ticker) return 0;
  const price = ticker.lastPrice ?? ticker.last_price ?? ticker.last_price_e4 ?? ticker.last_price_e5 ?? ticker.mark_price ?? ticker.price ?? ticker.close;
  return parseFloat(price) || 0;
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

async function getLatestPrice(symbol = SYMBOL) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const resp = await axios.get(`${BYBIT_BASE_URL}/v5/market/tickers`, { params: { symbol, category: 'linear' }, timeout: 15000 });
      const ticker = extractTickerFromResponse(resp.data);
      const price = parseTickerPrice(ticker);
      if (price > 0) return price;

      console.warn(chalk.yellow(`⚠️ Could not parse market price from ticker response for ${symbol}. Response: ${JSON.stringify(resp.data)}`));
      if (attempt < 3) {
        await sleep(500 * Math.pow(2, attempt - 1));
        continue;
      }
      return 0;
    } catch (err) {
      const isNetworkErr = err.code === 'ENOTFOUND' || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'EAI_AGAIN';
      if (isNetworkErr && attempt < 3) {
        await sleep(500 * Math.pow(2, attempt - 1));
        continue;
      }
      throw err;
    }
  }
  return 0;
}

async function getWalletBalance() {
  const data = await bybitRequest('GET', '/v5/account/wallet-balance', {
    coin: 'USDT',
    accountType: 'UNIFIED',
  });

  const account = data.list?.find((acc) => acc.accountType === 'UNIFIED') || data.list?.[0] || data;
  const usdt = account?.coin?.find((c) => c.coin === 'USDT') || account;
  return parseFloat(usdt?.available_balance ?? usdt?.walletBalance ?? usdt?.equity ?? 0) || 0;
}

function calculateMaxQty(availableBalance, price) {
  if (!price || price <= 0) return 0;
  const safetyFactor = 0.95;
  const maxQty = (availableBalance * LEVERAGE * safetyFactor) / price;
  const rounded = Math.floor(maxQty * 10 ** QTY_PRECISION) / 10 ** QTY_PRECISION;
  return formatQty(rounded);
}

async function syncServerTime() {
  try {
    const response = await axios.get(`${BYBIT_BASE_URL}/v3/public/time`);
    const serverTime = parseFloat(response.data.result.timeNano) / 1e6;
    timeOffset = Math.round(serverTime - Date.now());
    console.log(chalk.yellow(`⏰ Server time sync: offset = ${timeOffset}ms`));
  } catch (err) {
    console.error(chalk.red("⚠️  Could not sync server time, using local time"));
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
        url: `${BYBIT_BASE_URL}${path}`,
        timeout: 15000,
        headers: {
          "X-BAPI-API-KEY": API_KEY,
          "X-BAPI-TIMESTAMP": timestamp,
          "X-BAPI-RECV-WINDOW": RECV_WINDOW,
        },
      };

      // For POST, send params in body and sign with timestamp+api_key+recv_window+body format
      if (method.toUpperCase() === "POST") {
        config.data = params;
        const jsonBody = JSON.stringify(params);
        config.headers["Content-Type"] = "application/json";
        config.headers["X-BAPI-SIGN"] = signPostRequest(timestamp, jsonBody);
      } else {
        // For GET, use query params with sorted query string signature
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

      // debug: show full request URL for troubleshooting
      console.log(chalk.gray(`➡️ Bybit request: ${method.toUpperCase()} ${config.url}`));

      // keep last config for possible fallback
      lastConfig = config;

      const { data } = await axios(config);
      if (data.retCode && data.retCode !== 0) {
        const msg = data.retMsg || JSON.stringify(data);
        console.error(chalk.red(`❌ Bybit API returned error payload: ${JSON.stringify(data)}`));
        throw new Error(msg);
      }
      return data.result ?? data;
    } catch (err) {
      lastErr = err;
      const isNetworkErr = err.code === 'ENOTFOUND' || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'EAI_AGAIN';
      if (isNetworkErr && attempt < maxAttempts) {
        const waitMs = 500 * Math.pow(2, attempt - 1);
        console.warn(chalk.yellow(`⚠️ Network error (${err.code}). Retry ${attempt}/${maxAttempts} in ${waitMs}ms...`));
        await sleep(waitMs);
        continue;
      }

      // last resort: try alternate DNS resolution and request by IP
      if (isNetworkErr && lastConfig) {
        try {
          console.warn(chalk.yellow('⚠️ Attempting alternate DNS resolution (8.8.8.8/1.1.1.1) and request by IP'));
          const altResp = await requestViaAlternateDns(lastConfig.url, lastConfig);
          const altData = altResp.data;
          if (altData.retCode && altData.retCode !== 0) {
            throw new Error(altData.retMsg || JSON.stringify(altData));
          }
          return altData.result ?? altData;
        } catch (altErr) {
          console.error(chalk.red('❌ Alternate DNS request failed:'), altErr.message || altErr);
        }
      }

      // try to surface full response when available
      if (err.response) {
        console.error(chalk.red(`❌ Bybit HTTP ${err.response.status} ${err.response.statusText}`));
        console.error(chalk.red('Response data:'), err.response.data);
        if (err.response.status === 404) {
          console.error(chalk.red('⚠️ 404 Not Found - check the endpoint path and API version for this request.'));
        }
      } else {
        console.error(chalk.red('❌ Bybit API error:'), err.message);
        if (err.code === 'ENOTFOUND') {
          console.error(chalk.red('⚠️ DNS lookup failed for BYBIT host. Check network, DNS, or BYBIT_BASE_URL in .env'));
        }
      }

      throw err;
    }
  }

  // if we fallthrough, rethrow the last error
  throw lastErr;
}

function mapIntervalToBybit(interval) {
  const map = {
    "1m": "1",
    "5m": "5",
    "15m": "15",
    "30m": "30",
    "1h": "60",
    "4h": "240",
    "1d": "D",
  };
  return map[interval] || interval;
}

async function getCandles() {
  const intervalValue = mapIntervalToBybit(INTERVAL);
  // public market data: retry transient network errors
  let data;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const resp = await axios.get(`${BYBIT_BASE_URL}/v5/market/kline`, {
        params: { symbol: SYMBOL, interval: intervalValue, limit: 100 },
        timeout: 15000,
      });
      data = resp.data;
      break;
    } catch (err) {
      const isNetworkErr = err.code === 'ENOTFOUND' || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'EAI_AGAIN';
      if (isNetworkErr && attempt < 3) {
        const wait = 500 * Math.pow(2, attempt - 1);
        console.warn(chalk.yellow(`⚠️ Network error fetching candles (${err.code}), retry ${attempt}/3 in ${wait}ms`));
        // eslint-disable-next-line no-await-in-loop
        await sleep(wait);
        continue;
      }
      throw err;
    }
  }

  const candles = (data.result?.list || []).map((c) => ({
    time: parseInt(c[0], 10),
    open: parseFloat(c[1]),
    high: parseFloat(c[2]),
    low: parseFloat(c[3]),
    close: parseFloat(c[4]),
  }));

  return candles;
}

function countMovingAverageCrossovers(candles, fastPeriod = 5, slowPeriod = 10, lookback = 7) {
  const closes = candles.map((c) => c.close);
  const smaFast = SMA.calculate({ period: fastPeriod, values: closes });
  const smaSlow = SMA.calculate({ period: slowPeriod, values: closes });

  if (smaFast.length < 1 || smaSlow.length < 1) return 0;
  const fastAligned = smaFast.slice(smaFast.length - smaSlow.length);
  if (fastAligned.length !== smaSlow.length) return 0;

  const diff = fastAligned.map((value, idx) => value - smaSlow[idx]);
  if (diff.length < 2) return 0;

  let crossovers = 0;
  const start = Math.max(1, diff.length - lookback);
  for (let i = start; i < diff.length; i += 1) {
    const prev = diff[i - 1];
    const current = diff[i];
    if (prev === 0 || current === 0) continue;
    if ((prev < 0 && current > 0) || (prev > 0 && current < 0)) {
      crossovers += 1;
    }
  }

  return crossovers;
}

function getSignal(candles) {
  const closes = candles.map((c) => c.close);
  const sma5 = SMA.calculate({ period: 5, values: closes });
  const sma10 = SMA.calculate({ period: 10, values: closes });

  const crossovers = countMovingAverageCrossovers(candles, 5, 10, 7);
  if (crossovers > 1) {
    console.log(chalk.gray(`ℹ️ Skipping entry: ${crossovers} SMA crossovers detected in the last 7 candles.`));
    return null;
  }

  const prev5 = sma5[sma5.length - 2];
  const prev10 = sma10[sma10.length - 2];
  const last5 = sma5[sma5.length - 1];
  const last10 = sma10[sma10.length - 1];

  if (prev5 < prev10 && last5 > last10) return "BUY";
  if (prev5 > prev10 && last5 < last10) return "SELL";
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestViaAlternateDns(originalUrl, axiosConfig = {}) {
  try {
    const u = new URL(originalUrl);
    const hostname = u.hostname;
    const resolver = new dns.Resolver();
    resolver.setServers(['8.8.8.8', '1.1.1.1']);
    const addrs = await resolver.resolve4(hostname);
    if (!addrs || addrs.length === 0) throw new Error('No A records from alternate DNS');
    const ip = addrs[0];
    const newUrl = originalUrl.replace(hostname, ip);

    // ensure Host header and SNI servername for TLS
    axiosConfig.headers = axiosConfig.headers || {};
    axiosConfig.headers.Host = hostname;
    axiosConfig.httpsAgent = new https.Agent({ servername: hostname });

    return await axios({ url: newUrl, ...axiosConfig });
  } catch (err) {
    throw err;
  }
}

async function cancelAllOrders() {
  try {
    await bybitRequest("POST", "/v5/order/cancel-all", {
      category: "linear",
      symbol: SYMBOL,
    });
    console.log(chalk.yellow("🧹 Cancelled existing open orders (TP/SL)"));
    lastPositionClosedAt = Date.now();
  } catch (e) {
    console.error("⚠️ Failed to cancel open orders:", e.message);
  }
}

async function setLeverageIfPossible(requestFn = bybitRequest) {
  try {
    await requestFn("POST", "/v5/position/set-leverage", {
      category: "linear",
      symbol: SYMBOL,
      buyLeverage: String(LEVERAGE),
      sellLeverage: String(LEVERAGE),
    });
    console.log(chalk.green(`✅ Leverage set to ${LEVERAGE}x`));
    return true;
  } catch (e) {
    const isAlreadySet = e.message?.includes('leverage not modified') || e.response?.data?.retCode === 110043;
    if (isAlreadySet) {
      console.log(chalk.yellow('ℹ️ Leverage already set or unchanged, continuing.'));
      return true;
    }
    console.warn(chalk.yellow(`⚠️ Leverage change skipped: ${e.message}`));
    return false;
  }
}

async function openPosition(side) {
  try {
    await cancelAllOrders();

    const secondsSinceLastClose = (Date.now() - lastPositionClosedAt) / 1000;
    if (secondsSinceLastClose < 60 && lastPositionClosedAt !== 0) {
      const waitMs = (60 - secondsSinceLastClose) * 1000;
      console.log(chalk.gray(`⏳ Waiting ${Math.ceil(waitMs / 1000)}s before opening new position...`));
      await sleep(waitMs);
    }

    const bybitSide = toBybitSide(side);
    await setLeverageIfPossible();

    const price = await getLatestPrice(SYMBOL);
    if (!price || price <= 0) {
      console.log(chalk.red('❌ Could not retrieve market price; aborting entry.'));
      return;
    }

    const availableBalance = await getWalletBalance();
    const maxQty = calculateMaxQty(availableBalance, price);
    const orderQty = Math.min(QUANTITY, maxQty);

    if (orderQty <= 0) {
      console.log(chalk.red(`❌ Insufficient available balance (${availableBalance} USDT) for any size at price ${price}.`));
      return;
    }

    if (orderQty < QUANTITY) {
      console.log(chalk.yellow(`⚠️ Reducing order qty from ${QUANTITY} to ${orderQty} due to available balance ${availableBalance} USDT`));
    }

    console.log(`🚀 Opening ${side} (${orderQty}) with available balance ${availableBalance} USDT`);
    await bybitRequest("POST", "/v5/order/create", {
      category: "linear",
      symbol: SYMBOL,
      side: bybitSide,
      orderType: "Market",
      qty: String(orderQty),
    });

    console.log("⏳ Waiting for entry price...");
    await sleep(30000);

    let entryPrice = 0;
    let actualQty = 0;
    for (let i = 0; i < 6; i += 1) {
      const positionInfo = await bybitRequest("GET", "/v5/position/list", {
        category: "linear",
        symbol: SYMBOL,
        settleCoin: "USDT",
      });
      const position = Array.isArray(positionInfo)
        ? positionInfo[0]
        : positionInfo?.list?.[0] || positionInfo;
      entryPrice = parseFloat(position?.entry_price || 0);
      actualQty = Math.abs(parseFloat(position?.size || position?.pos_qty || 0));
      if (entryPrice > 0 && actualQty > 0) break;
      console.log(chalk.gray("⏳ Waiting for Bybit to confirm entry price..."));
      await sleep(3000);
    }

    if (!entryPrice || actualQty <= 0) {
      console.log("⚠️ No entry price or filled position found after retries, skipping TP/SL placement.");
      return;
    }

    console.log(chalk.green(`✅ ${side} MARKET order success @ ${entryPrice} with qty ${actualQty}`));
    await sleep(8000);

    const { tp, sl, qty80, remainingQty } = await placeTP_SL(side, entryPrice, actualQty);
    console.log(`✅ ${side} opened @ ${entryPrice} | 🎯 TP: ${tp.toFixed(2)} | 🛑 SL: ${sl.toFixed(2)} | TP80:${qty80} rem:${remainingQty}`);

    currentPosition = side;
    monitorTrailingStop(side, entryPrice, tp, sl, remainingQty);
  } catch (e) {
    console.error("❌ Failed to open position:", e.message);
  }
}

async function placeTP_SL(side, entryPrice, orderQty) {
  let tp = 0;
  let sl = 0;

  try {
    const opposite = side === "BUY" ? "SELL" : "BUY";
    if (side === "BUY") {
      tp = formatPrice(entryPrice * (1 + TP_PERCENT));
      sl = formatPrice(entryPrice * (1 - SL_PERCENT));
    } else {
      tp = formatPrice(entryPrice * (1 - TP_PERCENT));
      sl = formatPrice(entryPrice * (1 + SL_PERCENT));
    }

    const { tpQty, slQty, remainingQty, tpOrder, slOrder } = buildSlTpOrders({
      side,
      entryPrice,
      qty: orderQty,
      tpPercent: TP_PERCENT,
      slPercent: SL_PERCENT,
    });

    if (remainingQty === 0) {
      console.log(chalk.yellow('⚠️ Order quantity too small for partial TP; using full position for TP and SL protection.'));
    }

    console.log(`🎯 TP: ${tp} | 🛑 SL: ${sl}`);

    const tpResp = await bybitRequest("POST", "/v5/order/create", tpOrder);
    await bybitRequest("POST", "/v5/order/create", slOrder);

    return { tp, sl, qty80: tpQty, remainingQty, tpOrderId: tpResp?.orderId || null };
  } catch (e) {
    console.error(chalk.red(`⚠️ Failed to place TP/SL orders: ${e.message}`));
    console.error("Full error:", e);
    fs.appendFileSync("signals.log", `[${new Date().toISOString()}] ❌ TP/SL error: ${e.message}\n`);
    return { tp: 0, sl: 0, qty80: 0, remainingQty: 0 };
  }
}

async function monitorTrailingStop(side, entryPrice, tp, sl, remainingQty = 0) {
  try {
    console.log(chalk.gray("📈 Monitoring for trailing stop trigger / partial TP..."));

    const triggerPrice = side === "BUY"
      ? entryPrice + (tp - entryPrice) * 0.4
      : entryPrice - (entryPrice - tp) * 0.4;

    console.log(chalk.yellow(`⏱️ Trailing activation threshold: ${triggerPrice.toFixed(8)}`));

    let triggered = false;

    while (!triggered && currentPosition === side) {
      // resilient ticker fetch
      let tickerData;
      for (let a = 1; a <= 3; a += 1) {
        try {
          const resp = await axios.get(`${BYBIT_BASE_URL}/v5/market/tickers`, { params: { symbol: SYMBOL, category: 'linear' }, timeout: 8000 });
          tickerData = resp.data;
          break;
        } catch (err) {
          const isNetworkErr = err.code === 'ENOTFOUND' || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'EAI_AGAIN';
          if (isNetworkErr && a < 3) {
            await sleep(500 * Math.pow(2, a - 1));
            continue;
          }
          throw err;
        }
      }
      const ticker = extractTickerFromResponse(tickerData);
      const price = parseTickerPrice(ticker);

      if ((side === "BUY" && price >= triggerPrice) || (side === "SELL" && price <= triggerPrice)) {
        triggered = true;
        console.log(chalk.green(`🔥 Activation reached at price ${price}. Waiting for partial TP execution...`));
        await sleep(2000);

        let posRemaining = 0;
        for (let i = 0; i < 12; i += 1) {
const positionInfo = await bybitRequest("GET", "/v5/position/list", {
          category: "linear",
          symbol: SYMBOL,
          settleCoin: "USDT",
        });
        const position = Array.isArray(positionInfo)
          ? positionInfo[0]
          : positionInfo?.list?.[0] || positionInfo;
          posRemaining = Math.abs(parseFloat(position?.size || position?.pos_qty || 0));

          if (remainingQty > 0 && Math.abs(posRemaining - remainingQty) <= Math.max(remainingQty * 0.05, 0.000001)) {
            console.log(chalk.green(`✅ Detected partial TP execution. remaining ≈ ${posRemaining}`));
            break;
          }
          if (posRemaining === 0) {
            console.log(chalk.yellow("ℹ️ Position fully closed after TP."));
            break;
          }
          await sleep(5000);
        }

        if (posRemaining > 0) {
          await cancelAllOrders();

          // resilient current ticker fetch
          let currentTickerData;
          for (let a = 1; a <= 3; a += 1) {
            try {
              const resp = await axios.get(`${BYBIT_BASE_URL}/v5/market/tickers`, { params: { symbol: SYMBOL, category: 'linear' }, timeout: 8000 });
              currentTickerData = resp.data;
              break;
            } catch (err) {
              const isNetworkErr = err.code === 'ENOTFOUND' || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'EAI_AGAIN';
              if (isNetworkErr && a < 3) {
                await sleep(500 * Math.pow(2, a - 1));
                continue;
              }
              throw err;
            }
          }
          const ticker = extractTickerFromResponse(currentTickerData);
          const curPrice = parseTickerPrice(ticker);

          const hardStopPrice = side === "BUY"
            ? entryPrice * (1 - SL_PERCENT)
            : entryPrice * (1 + SL_PERCENT);

          await bybitRequest("POST", "/v5/order/create", buildExitOrderParams(side, hardStopPrice, posRemaining, "SL"));

          console.log(chalk.cyan(`🛑 Hard SL for remaining ${formatQty(posRemaining)} set at ${hardStopPrice.toFixed(8)}`));
        } else {
          console.log(chalk.gray("ℹ️ No remaining position to attach trailing stop to."));
        }
      }

      await sleep(5000);
    }
  } catch (e) {
    console.error("⚠️ Error in trailing stop monitor:", e.message);
    fs.appendFileSync("signals.log", `[${new Date().toISOString()}] ❌ trailing-monitor error: ${e.message}\n`);
  }
}

async function tradingWatcher() {
  try {
    const candles = await getCandles();
    const signal = getSignal(candles);

    const timeSinceLastTrade = (Date.now() - lastTradeTime) / 1000;
    if (timeSinceLastTrade < 1800) {
      const remaining = Math.ceil((1800 - timeSinceLastTrade) / 60);
      console.log(chalk.gray(`⏳ Cooldown active (${remaining}m left before next trade)...`));
      return;
    }

    if (signal && signal !== currentPosition) {
      console.log(chalk.magenta(`[Signal] ${signal} detected. Waiting ${CONFIRMATION_WAIT / 1000}s for confirmation...`));
      await sleep(CONFIRMATION_WAIT);
      const newCandles = await getCandles();
      const confirmSignal = getSignal(newCandles);

      if (confirmSignal === signal) {
        console.log(chalk.green(`[Confirmed] ${signal} still valid after ${CONFIRMATION_WAIT / 1000}s.`));
        await openPosition(signal);
        lastTradeTime = Date.now();
      } else {
        console.log(chalk.gray(`[Ignored] ${signal} invalidated after ${CONFIRMATION_WAIT / 1000}s.`));
      }
    } else {
      console.log("ℹ️ No new SMA crossover signal.");
    }
  } catch (e) {
    console.error("⚠️ Watcher error:", e.message);
  }
}



function startTradingWatcher() {
  if (watcherInterval) {
    console.log("⚠️ Watcher already running");
    return;
  }
  console.log("🚀 Starting trading watcher...");

  // Sync server time once at startup
  syncServerTime().catch(err => console.error("Time sync failed:", err.message));

  tradingWatcher(); // ✅ run immediately once on startup
  // Poll at least every interval (or 70s for shorter intervals)
  const pollInterval = Math.max(CONFIRMATION_WAIT / 2, 70 * 1000);
  watcherInterval = setInterval(tradingWatcher, pollInterval);
}

function stopTradingWatcher() {
  if (watcherInterval) {
    clearInterval(watcherInterval);
    watcherInterval = null;
    console.log("🛑 Trading watcher stopped");
  }
}

module.exports = { startTradingWatcher, stopTradingWatcher, setLeverageIfPossible, buildExitOrderParams, buildSlTpOrders };
