// ============================================================================
// 8. ENTRY POINT (src/index.ts)
// ============================================================================

import { TradingBot } from "./core/TradingBot";
import { config } from "./config";

async function main() {
  const bot = new TradingBot(config);

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n\n⚠️ Shutting down gracefully...');
    bot.stop();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    bot.stop();
    process.exit(0);
  });

  try {
    await bot.start();
  } catch (error) {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  }
}

main();