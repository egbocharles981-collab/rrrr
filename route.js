const express = require('express');
const router = express.Router();
const os = require('os');
const axios = require('axios');

// ✅ Import separate controllers
const controler = require('./controler');
const futuresController = require('./autotrader');

// === ROUTES ===

// ✅ 1️⃣ Fetch latest candlestick data
router.get('/candle', async (req, res) => {
  try {
    await controler.getCandles(req, res);
  } catch (error) {
    console.error('❌ /candle route error:', error.message);
    res.status(500).json({ error: 'Failed to fetch candle data' });
  }
});

// ✅ 2️⃣ Execute a manual trade (Spot)
router.post('/trade', async (req, res) => {
  try {
    await controler.executeTrade(req, res);
  } catch (error) {
    console.error('❌ /trade route error:', error.message);
    res.status(500).json({ error: 'Failed to execute trade' });
  }
});

// ✅ 3️⃣ Start the Futures trading watcher loop
router.post('/futures/start', async (req, res) => {
  try {
    futuresController.startTradingWatcher();
    console.log('🚀 Trading watcher started');
    res.json({ success: true, message: 'Trading watcher started successfully.' });
  } catch (error) {
    console.error('❌ Failed to start watcher:', error.message);
    res.status(500).json({ success: false, message: 'Failed to start watcher', error: error.message });
  }
});

// ✅ 4️⃣ Stop the Futures trading watcher loop
router.post('/futures/stop', async (req, res) => {
  try {
    futuresController.stopTradingWatcher();
    console.log('🛑 Trading watcher stopped');
    res.json({ success: true, message: 'Trading watcher stopped successfully.' });
  } catch (error) {
    console.error('❌ Failed to stop watcher:', error.message);
    res.status(500).json({ success: false, message: 'Failed to stop watcher', error: error.message });
  }
});

// ✅ Return only the public IP (via api.ipify.org)
router.get('/ip', async (req, res) => {
  try {
    let publicIp = null;
    try {
      const r = await axios.get('https://api.ipify.org?format=json', { timeout: 3000 });
      publicIp = r.data?.ip || null;
    } catch (e) {
      publicIp = null;
    }

    if (!publicIp) {
      return res.status(502).json({ error: 'Failed to fetch public IP' });
    }

    res.json({ publicIp });
  } catch (err) {
    console.error('❌ /ip route error:', err.message);
    res.status(500).json({ error: 'Failed to determine public IP' });
  }
});

module.exports = router;
