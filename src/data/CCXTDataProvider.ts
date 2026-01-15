// ============================================================================
// 3. CCXT MARKET DATA PROVIDER (src/data/CCXTDataProvider.ts)
// ============================================================================

import * as ccxt from 'ccxt';
import { MarketData, OHLCV } from '../types';
import { BotConfig, CoinConfig } from '../config';

export class CCXTDataProvider {
  private exchange: ccxt.Exchange;
  private marketDataCache: Map<string, MarketData> = new Map();
  private ohlcvCache: Map<string, Map<string, OHLCV[]>> = new Map();
  private updateInterval?: NodeJS.Timeout;

  constructor(config: BotConfig) {
    const ExchangeClass = ccxt[config.ccxt.exchange as keyof typeof ccxt] as any;
    this.exchange = new ExchangeClass({
      enableRateLimit: config.ccxt.enableRateLimit,
      options: config.ccxt.options,
    });
  }

  async start(coins: CoinConfig[]): Promise<void> {
    console.log('📊 Starting CCXT Data Provider...');
    
    // Initial data fetch
    await this.updateAllMarketData(coins);

    // Update every 30 seconds
    this.updateInterval = setInterval(() => {
      this.updateAllMarketData(coins);
    }, 30000);

    console.log('✅ CCXT Data Provider started');
  }

  private async updateAllMarketData(coins: CoinConfig[]): Promise<void> {
    const promises = coins
      .filter(c => c.enabled)
      .map(coin => this.updateCoinData(coin));

    await Promise.allSettled(promises);
  }

  private async updateCoinData(coin: CoinConfig): Promise<void> {
    try {
      // Fetch OHLCV data for all timeframes
      const intervals = ['1m', '5m', '15m', '1h'];
      const ohlcvPromises = intervals.map(interval =>
        this.exchange.fetchOHLCV(coin.ccxtSymbol, interval, undefined, 20)
      );

      const results = await Promise.all(ohlcvPromises);

      // Store OHLCV data
      if (!this.ohlcvCache.has(coin.symbol)) {
        this.ohlcvCache.set(coin.symbol, new Map());
      }
      const coinCache = this.ohlcvCache.get(coin.symbol)!;

      intervals.forEach((interval, idx) => {
        const ohlcvData = results[idx].map(candle => ({
          timestamp: candle[0],
          open: candle[1],
          high: candle[2],
          low: candle[3],
          close: candle[4],
          volume: candle[5],
        }));
        coinCache.set(interval, ohlcvData);
      });

      // Calculate market data
      const marketData = this.calculateMarketData(coin.symbol);
      if (marketData) {
        this.marketDataCache.set(coin.symbol, marketData);
      }
    } catch (error) {
      console.error(`❌ Error updating ${coin.symbol}:`, error);
    }
  }

  private calculateMarketData(symbol: string): MarketData | null {
    const coinCache = this.ohlcvCache.get(symbol);
    if (!coinCache) return null;

    const candles1m = coinCache.get('1m');
    const candles5m = coinCache.get('5m');
    const candles15m = coinCache.get('15m');
    const candles1h = coinCache.get('1h');

    if (!candles1m || !candles1h || candles1m.length === 0 || candles1h.length === 0) {
      return null;
    }

    const currentPrice = candles1m[candles1m.length - 1].close;
    const hourOpen = candles1h[candles1h.length - 1].open;

    const price1mAgo = candles1m.length > 1 ? candles1m[candles1m.length - 2].close : currentPrice;
    const price5mAgo = candles5m && candles5m.length > 0 
      ? candles5m[candles5m.length - 1].close 
      : currentPrice;
    const price15mAgo = candles15m && candles15m.length > 0 
      ? candles15m[candles15m.length - 1].close 
      : currentPrice;
    const price1hAgo = candles1h.length > 1 ? candles1h[candles1h.length - 2].close : currentPrice;

    // Calculate volatility (standard deviation of returns)
    const returns = candles1h.slice(-10).map((c, i, arr) => 
      i === 0 ? 0 : (c.close - arr[i - 1].close) / arr[i - 1].close
    );
    const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length;
    const volatility = Math.sqrt(variance) * 100;

    return {
      symbol,
      price: currentPrice,
      hourOpen,
      priceChange1m: ((currentPrice - price1mAgo) / price1mAgo) * 100,
      priceChange5m: ((currentPrice - price5mAgo) / price5mAgo) * 100,
      priceChange15m: ((currentPrice - price15mAgo) / price15mAgo) * 100,
      priceChange1h: ((currentPrice - price1hAgo) / price1hAgo) * 100,
      volume24h: candles1h.reduce((sum, c) => sum + c.volume, 0),
      volatility,
      timestamp: Date.now(),
    };
  }

  getMarketData(symbol: string): MarketData | null {
    return this.marketDataCache.get(symbol) || null;
  }

  getOHLCV(symbol: string, interval: string): OHLCV[] | null {
    const coinCache = this.ohlcvCache.get(symbol);
    return coinCache?.get(interval) || null;
  }

  stop(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
    }
    console.log('✅ CCXT Data Provider stopped');
  }
}
