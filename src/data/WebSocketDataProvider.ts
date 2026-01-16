// ============================================================================
// BINANCE WEBSOCKET DATA PROVIDER (src/data/BinanceWebSocketDataProvider.ts)
// ============================================================================

import * as ccxt from 'ccxt';
import WebSocket from 'ws';
import { MarketData, OHLCV } from '../types';
import { BotConfig, CoinConfig } from '../config';

interface PriceHistory {
  prices: number[];
  timestamps: number[];
  maxLength: number;
}

interface BinanceKline {
  e: string;      // Event type
  E: number;      // Event time
  s: string;      // Symbol
  k: {
    t: number;    // Kline start time
    T: number;    // Kline close time
    s: string;    // Symbol
    i: string;    // Interval
    f: number;    // First trade ID
    L: number;    // Last trade ID
    o: string;    // Open price
    c: string;    // Close price
    h: string;    // High price
    l: string;    // Low price
    v: string;    // Base asset volume
    n: number;    // Number of trades
    x: boolean;   // Is this kline closed?
    q: string;    // Quote asset volume
    V: string;    // Taker buy base asset volume
    Q: string;    // Taker buy quote asset volume
    B: string;    // Ignore
  };
}

export class BinanceWebSocketDataProvider {
  private exchange: ccxt.Exchange;
  private ws: WebSocket | null = null;
  private priceHistory: Map<string, PriceHistory> = new Map();
  private marketDataCache: Map<string, MarketData> = new Map();
  private running: boolean = false;
  private config: BotConfig;
  private coins: CoinConfig[] = [];
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 10;
  private reconnectDelay: number = 5000;
  private pingInterval: NodeJS.Timeout | null = null;
  private subscriptionId: number = 1;
  private subscribed: boolean = false; // guard so we don't re-subscribe repeatedly

  constructor(config: BotConfig) {
    this.config = config;

    const ExchangeClass = ccxt[config.ccxt.exchange as keyof typeof ccxt] as any;
    this.exchange = new ExchangeClass({
      enableRateLimit: config.ccxt.enableRateLimit,
      options: config.ccxt.options,
    });
  }

  async start(coins: CoinConfig[]): Promise<void> {
    console.log('📊 Starting Binance WebSocket Data Provider...');

    this.coins = coins.filter(c => c.enabled);
    this.running = true;

    // Initialize price history for each coin
    for (const coin of this.coins) {
      this.priceHistory.set(coin.symbol, {
        prices: [],
        timestamps: [],
        maxLength: 3600, // Store up to 1 hour of data
      });
    }

    // Fetch initial historical data using CCXT
    await this.fetchInitialData();

    // Connect to Binance WebSocket
    this.connectWebSocket();

    console.log('✅ Binance WebSocket Data Provider started');
  }

  /**
   * Wait for WebSocket connection to be established
   */
  async waitForConnection(timeoutMs: number = 30000): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      if (this.ws?.readyState === WebSocket.OPEN) {
        console.log('✅ Binance WebSocket connection confirmed');
        return true;
      }

      // Wait 100ms before checking again
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    console.error('❌ Binance WebSocket connection timeout');
    return false;
  }


  private async fetchInitialData(): Promise<void> {
    console.log('📥 Fetching initial market data...');

    for (const coin of this.coins) {
      try {
        // Fetch last 15 minutes of 1m candles
        const ohlcv = await this.exchange.fetchOHLCV(coin.ccxtSymbol, '1m', undefined, 15);

        if (ohlcv && ohlcv.length > 0) {
          const history = this.priceHistory.get(coin.symbol);
          if (!history) continue;

          // Populate history with OHLCV data
          for (const candle of ohlcv) {
            const timestamp = candle[0];
            const close = candle[4];

            history.prices.push(close);
            history.timestamps.push(timestamp);
          }

          // Calculate initial market data
          this.calculateMarketData(coin.symbol);

          console.log(`✅ ${coin.symbol}: Loaded ${ohlcv.length} candles`);
        }
      } catch (error) {
        console.error(`❌ Error fetching initial data for ${coin.symbol}:`, error);
      }
    }
  }

  private connectWebSocket(): void {
    // Use the websocket server host and port recommended by Binance for JSON SUBSCRIBE
    const wsUrl = 'wss://stream.binance.com:9443/ws';

    try {
      // clean up any previous state
      this.cleanup();

      this.ws = new WebSocket(wsUrl);

      this.ws.on('open', () => {
        console.log('✅ Binance WebSocket connected');
        this.reconnectAttempts = 0;
        this.subscribed = false; // allow subscribe once per open
        this.subscribeToStreams();
        this.startPingInterval();
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        this.handleMessage(data);
      });

      this.ws.on('close', (code: number, reason: Buffer | string) => {
        // reason may be a Buffer — convert to string for readable logging
        const reasonStr = (reason instanceof Buffer) ? reason.toString() : (reason ?? '').toString();
        console.log(`⚠️ Binance WebSocket closed: ${code} - ${reasonStr}`);
        this.handleClose();
      });

      this.ws.on('error', (error: Error) => {
        console.error('❌ Binance WebSocket error:', error);
      });

      this.ws.on('pong', () => {
        // server replied to our ping
      });
    } catch (error) {
      console.error('Failed to create WebSocket connection:', error);
      this.handleClose();
    }
  }

  private buildStreamNames(): string[] {
    // Convert CCXT symbols like "BTC/USDT" -> "btcusdt@kline_1m"
    const streams: string[] = [];
    for (const coin of this.coins) {
      try {
        const raw = coin.ccxtSymbol;
        if (!raw) continue;
        // normalize and validate
        const symbol = raw.replace('/', '').toLowerCase(); // e.g., btcusdt
        if (!symbol.endsWith('usdt') && !symbol.endsWith('btc') && !symbol.endsWith('eth')) {
          // don't strictly enforce all quote assets here — but ensure non-empty
        }
        streams.push(`${symbol}@kline_1m`);
      } catch (e) {
        console.warn('Skipping coin for stream build due to parse error:', coin, e);
      }
    }
    return streams;
  }

  private subscribeToStreams(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error('Cannot subscribe: WebSocket not connected');
      return;
    }

    // guard: subscribe only once per open
    if (this.subscribed) {
      console.log('Already subscribed on this connection; skipping duplicate subscribe.');
      return;
    }

    const streams = this.buildStreamNames();
    if (streams.length === 0) {
      console.warn('No streams to subscribe to.');
      return;
    }

    const subscriptionMessage = {
      method: 'SUBSCRIBE',
      params: streams,
      id: this.subscriptionId++,
    };

    console.log(`📡 Subscribing to ${streams.length} Binance streams:`, streams);

    // safe send wrapper
    try {
      const payload = JSON.stringify(subscriptionMessage);
      this.ws.send(payload, (err) => {
        if (err) {
          console.error('Error sending subscription message:', err);
        } else {
          // wait for the server confirmation (message.result === null && message.id)
          // but still mark subscribed to avoid spamming; if server rejects, close callback will handle.
          this.subscribed = true;
        }
      });
    } catch (err) {
      console.error('Failed to send subscription message:', err);
    }
  }

  private handleMessage(data: WebSocket.Data): void {
    try {
      // convert to string safely
      const text = (typeof data === 'string') ? data : data.toString();

      // Skip plain ping/pong textual messages if any (rare)
      if (text === 'ping' || text === 'pong') {
        return;
      }

      let message: any;
      try {
        message = JSON.parse(text);
      } catch (e) {
        // not JSON — ignore
        return;
      }

      // Binance returns different shapes depending on how you connect:
      // - If you used combined-stream via /stream?streams=... you'll get { stream: 'btcusdt@kline_1m', data: { e: 'kline', ... } }
      // - If using ws + SUBSCRIBE you may get the payload body directly (e.g., { e: 'kline', ... })
      // - Subscription confirmation: { result: null, id: <id> }
      if (message.result === null && message.id) {
        console.log(`✅ Subscription confirmed (id: ${message.id})`);
        return;
      }

      // combined-stream shape
      if (message.stream && message.data && message.data.e === 'kline') {
        this.handleKlineMessage(message.data as BinanceKline);
        return;
      }

      // direct kline shape
      if (message.e === 'kline') {
        this.handleKlineMessage(message as BinanceKline);
        return;
      }

      // ignore other messages
    } catch (error) {
      console.error('Error parsing Binance message:', error);
    }
  }

  private handleKlineMessage(kline: BinanceKline): void {
    // Convert symbol back to our format (e.g. BTCUSDT or BTC)
    const symbolRaw = kline.s; // e.g. BTCUSDT
    const pairSymbol = symbolRaw.replace('USDT', ''); // keeps like BTC
    // Find matching coin by normalizing both sides
    const coin = this.coins.find(c =>
      c.ccxtSymbol.replace('/', '').toUpperCase() === kline.s.toUpperCase()
    );

    if (!coin) return;

    const closePrice = parseFloat(kline.k.c);
    const timestamp = kline.k.T; // Kline close time

    // Update price history
    this.updatePriceHistory(coin.symbol, closePrice, timestamp);

    // Calculate market data
    this.calculateMarketData(coin.symbol);
  }

  private updatePriceHistory(symbol: string, price: number, timestamp: number): void {
    const history = this.priceHistory.get(symbol);
    if (!history) return;

    // Add new price
    history.prices.push(price);
    history.timestamps.push(timestamp);

    // Keep only recent data (1 hour)
    const cutoff = Date.now() - 3600000;
    while (history.timestamps.length > 0 && history.timestamps[0] < cutoff) {
      history.prices.shift();
      history.timestamps.shift();
    }

    // Also enforce max length
    while (history.prices.length > history.maxLength) {
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

    // Estimate volume (we don't have real-time volume from kline message)
    const volume24h = 0; // Would need separate API call

    // guard against division by zero in percent calculations:
    const safePct = (a: number, b: number) => (b === 0 ? 0 : ((a - b) / b) * 100);

    const marketData: MarketData = {
      symbol,
      price: currentPrice,
      hourOpen,
      priceChange1m: safePct(currentPrice, price1mAgo),
      priceChange5m: safePct(currentPrice, price5mAgo),
      priceChange15m: safePct(currentPrice, price15mAgo),
      priceChange1h: safePct(currentPrice, price1hAgo),
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

    // Only return if within 2 minutes of target (allow some tolerance)
    if (minDiff < 120000) {
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

  private startPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
    }

    // Send control ping every 30 seconds to keep connection alive.
    // IMPORTANT: use ws.ping() (control frame), not ws.send('ping') (application text).
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        try {
          this.ws.ping();
        } catch (err) {
          console.warn('Ping failed:', err);
        }
      }
    }, 30000);
  }

  private handleClose(): void {
    this.cleanup();

    if (!this.running) return;

    // Attempt reconnection
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = Math.round(this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1));

      console.log(`🔄 Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts}) in ${delay}ms...`);

      setTimeout(() => {
        if (this.running) {
          this.connectWebSocket();
        }
      }, delay);
    } else {
      console.error('❌ Max reconnection attempts reached');
    }
  }

  private cleanup(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    if (this.ws) {
      try {
        this.ws.removeAllListeners();
      } catch (e) {
        // ignore
      }

      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        try { this.ws.close(); } catch (e) { /* ignore */ }
      }
      this.ws = null;
    }
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

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async stop(): Promise<void> {
    console.log('🛑 Stopping Binance WebSocket Data Provider...');
    this.running = false;

    this.cleanup();

    console.log('✅ Binance WebSocket Data Provider stopped');
  }
}
