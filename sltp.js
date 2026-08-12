function formatPrice(value, precision = 2) {
  return Number(Number(value).toFixed(precision));
}

function formatQty(value, precision = 3) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** precision;
  return Math.max(0, Math.floor(value * factor) / factor);
}

function calculateSlTp({
  side,
  entryPrice,
  tpPercent = 0.015,
  slPercent = 0.007,
  pricePrecision = 2,
}) {
  if (!side || !Number.isFinite(entryPrice) || entryPrice <= 0) {
    throw new Error('Valid side and entryPrice are required.');
  }

  const normalizedSide = String(side).toUpperCase();
  const base = Number(entryPrice);

  if (normalizedSide === 'BUY') {
    return {
      side: 'BUY',
      entryPrice: base,
      tp: formatPrice(base * (1 + tpPercent), pricePrecision),
      sl: formatPrice(base * (1 - slPercent), pricePrecision),
      tpPercent,
      slPercent,
    };
  }

  if (normalizedSide === 'SELL') {
    return {
      side: 'SELL',
      entryPrice: base,
      tp: formatPrice(base * (1 - tpPercent), pricePrecision),
      sl: formatPrice(base * (1 + slPercent), pricePrecision),
      tpPercent,
      slPercent,
    };
  }

  throw new Error(`Unsupported side: ${side}. Use BUY or SELL.`);
}

function buildExitOrderParams({ side, symbol = 'BTCUSDT', triggerPrice, qty, kind, category = 'linear' }) {
  const normalizedSide = String(side).toUpperCase();
  const exitSide = normalizedSide === 'BUY' ? 'Sell' : 'Buy';
  const isTakeProfit = String(kind).toUpperCase() === 'TP';
  const normalizedTriggerPrice = formatPrice(triggerPrice, 2);
  const normalizedQty = formatQty(qty, 3);

  const params = {
    category,
    symbol,
    side: exitSide,
    orderType: isTakeProfit ? 'Limit' : 'Market',
    qty: String(normalizedQty),
    triggerPrice: String(normalizedTriggerPrice),
    triggerDirection: isTakeProfit
      ? (normalizedSide === 'BUY' ? 1 : 2)
      : (normalizedSide === 'BUY' ? 2 : 1),
    triggerBy: 'LastPrice',
    reduceOnly: true,
    closeOnTrigger: true,
  };

  if (isTakeProfit) {
    params.price = String(normalizedTriggerPrice);
    params.timeInForce = 'GoodTillCancel';
  } else {
    params.basePrice = String(normalizedTriggerPrice);
  }

  return params;
}

function buildSlTpOrders({ side, entryPrice, qty, tpPercent = 0.015, slPercent = 0.007, symbol = 'BTCUSDT' }) {
  const { tp, sl } = calculateSlTp({ side, entryPrice, tpPercent, slPercent });
  const qty80 = formatQty(qty * 0.8, 3);
  const remainingQty = formatQty(qty - qty80, 3);

  const tpQty = qty80 > 0 ? qty80 : qty;
  const slQty = qty;

  return {
    tp,
    sl,
    tpQty,
    slQty,
    remainingQty,
    tpOrder: buildExitOrderParams({ side, symbol, triggerPrice: tp, qty: tpQty, kind: 'TP' }),
    slOrder: buildExitOrderParams({ side, symbol, triggerPrice: sl, qty: slQty, kind: 'SL' }),
  };
}

module.exports = {
  formatPrice,
  formatQty,
  calculateSlTp,
  buildExitOrderParams,
  buildSlTpOrders,
};

if (require.main === module) {
  const exampleBuy = calculateSlTp({
    side: 'BUY',
    entryPrice: 100,
    tpPercent: 0.015,
    slPercent: 0.007,
  });

  const exampleSell = calculateSlTp({
    side: 'SELL',
    entryPrice: 100,
    tpPercent: 0.015,
    slPercent: 0.007,
  });

  const buyOrderSet = buildSlTpOrders({
    side: 'BUY',
    entryPrice: 100,
    qty: 0.5,
    tpPercent: 0.015,
    slPercent: 0.007,
  });

  const sellOrderSet = buildSlTpOrders({
    side: 'SELL',
    entryPrice: 100,
    qty: 0.5,
    tpPercent: 0.015,
    slPercent: 0.007,
  });

  console.log('SL/TP Example (BUY):');
  console.log(JSON.stringify(exampleBuy, null, 2));
  console.log('\nPartial TP/SL order setup (BUY):');
  console.log(JSON.stringify(buyOrderSet, null, 2));
  console.log('\nSL/TP Example (SELL):');
  console.log(JSON.stringify(exampleSell, null, 2));
  console.log('\nPartial TP/SL order setup (SELL):');
  console.log(JSON.stringify(sellOrderSet, null, 2));
}
