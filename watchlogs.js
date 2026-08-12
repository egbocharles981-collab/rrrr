// watchLogs.js
const fs = require("fs");
const chalk = require("chalk");

// Path to your log file
const LOG_FILE = "trading-log.txt";

// Start by printing a header
console.log(chalk.cyan("=== Bybit Futures Bot Log Monitor ==="));
console.log(chalk.gray(`Watching: ${LOG_FILE}\n`));

// Make sure the file exists
if (!fs.existsSync(LOG_FILE)) {
  console.log(chalk.yellow("⚠️ No trading-log.txt found yet. Waiting for logs..."));
  fs.writeFileSync(LOG_FILE, ""); // create empty file
}

// Start watching for changes
fs.watchFile(LOG_FILE, { interval: 1000 }, () => {
  const data = fs.readFileSync(LOG_FILE, "utf8");
  const lines = data.trim().split("\n").slice(-20); // show last 20 lines

  console.clear();
  console.log(chalk.cyan("=== Binance Futures Bot Log Monitor ==="));
  console.log(chalk.gray(`Updated: ${new Date().toLocaleTimeString()}\n`));

  lines.forEach((line) => {
    if (line.includes("❌")) console.log(chalk.red(line));
    else if (line.includes("⚠️")) console.log(chalk.yellow(line));
    else if (line.includes("✅")) console.log(chalk.green(line));
    else if (line.includes("🚀")) console.log(chalk.magenta(line));
    else console.log(chalk.white(line));
  });
});
