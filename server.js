require('dotenv').config(); // Load .env

const express = require('express');
const cors = require('cors');
const path = require('path');
const app = express();

// Load port from env or default
const port = process.env.PORT || 5001;

// ✅ Load trading controller (adjust path if needed)
const tradeController = require('./controler');

// ✅ Load routes file (you have routes.js, not folder)
const tradeRoutes = require('./route');

// ✅ Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // Serve frontend

// ✅ Use your routes file (if it exports a router)
app.use('/api', tradeRoutes);

// ✅ Root Health Check
app.get('/', (req, res) => {
  res.send('✅ AutoPatobot server is running!');
});

// ✅ Start the server
app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
  console.log(`🌐 Visit your app at http://localhost:${port}`);
});
