// ============================================================================
// WEBSOCKET CCXT DATA PROVIDER (src/data/WebSocketDataProvider.ts)
// ============================================================================

import * as ccxt from 'ccxt';
import { MarketData, OHLCV } from '../types';
import { BotConfig, CoinConfig } from '../config';

interface PriceHistory {
  prices: number[];
  timestamps: number[];
  maxLength: number;
}

export class WebSocketDataProvider {
  private exchange: ccxt.Exchange;
  private watcherPromises: Map<string, Promise<void>> = new Map();
  private priceHistory: Map<string, PriceHistory> = new Map();
  private marketDataCache: Map<string, MarketData> = new Map();
  private running: boolean = false;
  private config: BotConfig;

  constructor(config: BotConfig) {
    this.config = config;
    
    const ExchangeClass = ccxt[config.ccxt.exchange as keyof typeof ccxt] as any;
    this.exchange = new ExchangeClass({
      enableRateLimit: config.ccxt.enableRateLimit,
      options: config.ccxt.options,
    });
  }

  async start(coins: CoinConfig[]): Promise<void> {
    console.log('📊 Starting WebSocket Data Provider...');
    
    if (!this.exchange.has['watchTicker']) {
      console.warn('⚠️ Exchange does not support WebSocket tickers, falling back to REST');
      await this.startPolling(coins);
      return;
    }

    this.running = true;

    // Initialize price history for each coin
    for (const coin of coins.filter(c => c.enabled)) {
      this.priceHistory.set(coin.symbol, {
        prices: [],
        timestamps: [],
        maxLength: 3600, // Store up to 1 hour of second-by-second data
      });
    }

    // Start watching tickers for all coins
    for (const coin of coins.filter(c => c.enabled)) {
      const promise = this.watchTicker(coin);
      this.watcherPromises.set(coin.symbol, promise);
    }

    // Start background OHLCV fetcher for longer timeframes
    this.startOHLCVFetcher(coins);

    console.log('✅ WebSocket Data Provider started');
  }

  private async watchTicker(coin: CoinConfig): Promise<void> {
    while (this.running) {
      try {
        const ticker = await this.exchange.watchTicker(coin.ccxtSymbol);
        
        if (ticker && ticker.last) {
          this.updatePriceHistory(coin.symbol, ticker.last);
          this.calculateMarketData(coin.symbol);
        }
      } catch (error) {
        console.error(`❌ Error watching ${coin.symbol}:`, error);
        // Wait before retrying
        await this.sleep(5000);
      }
    }
  }

  private updatePriceHistory(symbol: string, price: number): void {
    const history = this.priceHistory.get(symbol);
    if (!history) return;

    const now = Date.now();
    
    history.prices.push(price);
    history.timestamps.push(now);

    // Keep only recent data (1 hour)
    const cutoff = now - 3600000;
    while (history.timestamps.length > 0 && history.timestamps[0] < cutoff) {
      history.prices.shift();
      history.timestamps.shift();
    }
  }

  private calculateMarketData(symbol: string): void {
    const history = this.priceHistory.get(symbol);
    if (!history || history.prices.length === 0) return;

    const now = Date.now();
    const currentPrice = history.prices[history.prices.length - 1];

    // Calculate price changes
    const price1mAgo = this.getPriceAtTime(history, now - 60000) || currentPrice;
    const price5mAgo = this.getPriceAtTime(history, now - 300000) || currentPrice;
    const price15mAgo = this.getPriceAtTime(history, now - 900000) || currentPrice;
    const price1hAgo = this.getPriceAtTime(history, now - 3600000) || currentPrice;

    // Get hour open (price at start of current hour)
    const currentHour = new Date(now);
    currentHour.setMinutes(0, 0, 0);
    const hourOpen = this.getPriceAtTime(history, currentHour.getTime()) || currentPrice;

    // Calculate volatility (standard deviation of recent prices)
    const recentPrices = history.prices.slice(-60); // Last 60 data points
    const volatility = this.calculateVolatility(recentPrices);

    // Estimate volume (we don't have real-time volume from ticker)
    const volume24h = 0; // Would need OHLCV data

    const marketData: MarketData = {
      symbol,
      price: currentPrice,
      hourOpen,
      priceChange1m: ((currentPrice - price1mAgo) / price1mAgo) * 100,
      priceChange5m: ((currentPrice - price5mAgo) / price5mAgo) * 100,
      priceChange15m: ((currentPrice - price15mAgo) / price15mAgo) * 100,
      priceChange1h: ((currentPrice - price1hAgo) / price1hAgo) * 100,
      volume24h,
      volatility,
      timestamp: now,
    };

    this.marketDataCache.set(symbol, marketData);
  }

  private getPriceAtTime(history: PriceHistory, targetTime: number): number | null {
    if (history.timestamps.length === 0) return null;

    // Find closest timestamp
    let closestIndex = 0;
    let minDiff = Math.abs(history.timestamps[0] - targetTime);

    for (let i = 1; i < history.timestamps.length; i++) {
      const diff = Math.abs(history.timestamps[i] - targetTime);
      if (diff < minDiff) {
        minDiff = diff;
        closestIndex = i;
      }
    }

    // Only return if within 10 seconds of target
    if (minDiff < 10000) {
      return history.prices[closestIndex];
    }

    return null;
  }

  private calculateVolatility(prices: number[]): number {
    if (prices.length < 2) return 0;

    const returns = prices.slice(1).map((price, i) => 
      (price - prices[i]) / prices[i]
    );

    const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
    
    return Math.sqrt(variance) * 100;
  }

  private async startOHLCVFetcher(coins: CoinConfig[]): Promise<void> {
    // Fetch OHLCV data every 60 seconds for longer timeframes
    const fetchInterval = setInterval(async () => {
      if (!this.running) {
        clearInterval(fetchInterval);
        return;
      }

      for (const coin of coins.filter(c => c.enabled)) {
        try {
          // Fetch 1h candle for hour open price
          const ohlcv = await this.exchange.fetchOHLCV(coin.ccxtSymbol, '1h', undefined, 2);
          
          if (ohlcv && ohlcv.length > 0) {
            const latestCandle = ohlcv[ohlcv.length - 1];
            const history = this.priceHistory.get(coin.symbol);
            
            if (history && history.prices.length === 0) {
              // Bootstrap with OHLCV data if no websocket data yet
              this.updatePriceHistory(coin.symbol, latestCandle[4]); // close price
            }
          }
        } catch (error) {
          console.error(`❌ Error fetching OHLCV for ${coin.symbol}:`, error);
        }
      }
    }, 60000);
  }

  private async startPolling(coins: CoinConfig[]): Promise<void> {
    // Fallback polling mechanism
    this.running = true;

    const poll = async () => {
      while (this.running) {
        for (const coin of coins.filter(c => c.enabled)) {
          try {
            const ticker = await this.exchange.fetchTicker(coin.ccxtSymbol);
            
            if (ticker && ticker.last) {
              this.updatePriceHistory(coin.symbol, ticker.last);
              this.calculateMarketData(coin.symbol);
            }
          } catch (error) {
            console.error(`❌ Error polling ${coin.symbol}:`, error);
          }
        }
        
        await this.sleep(1000); // Poll every second
      }
    };

    poll();
    console.log('✅ Polling Data Provider started (WebSocket not available)');
  }

  getMarketData(symbol: string): MarketData | null {
    return this.marketDataCache.get(symbol) || null;
  }

  getPriceHistory(symbol: string, minutes: number = 60): number[] {
    const history = this.priceHistory.get(symbol);
    if (!history) return [];

    const now = Date.now();
    const cutoff = now - (minutes * 60000);
    
    const recentPrices: number[] = [];
    for (let i = 0; i < history.timestamps.length; i++) {
      if (history.timestamps[i] >= cutoff) {
        recentPrices.push(history.prices[i]);
      }
    }
    
    return recentPrices;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async stop(): Promise<void> {
    console.log('🛑 Stopping WebSocket Data Provider...');
    this.running = false;

    // Close all watchers
    if (this.exchange.has['watchTicker']) {
      await this.exchange.close();
    }

    console.log('✅ WebSocket Data Provider stopped');
  }
}
