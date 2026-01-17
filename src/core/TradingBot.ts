// ============================================================================
// MAIN BOT WITH REBALANCING (src/core/TradingBot.ts)
// ============================================================================

import { BotConfig, CoinConfig } from "../config";
import { BinanceWebSocketDataProvider } from "../data/WebSocketDataProvider";
import { PolymarketClient } from "../polymarket/PolymarketClient";
import { RebalancingEngine } from "../strategy/RebalancingEngine";
import { DatabaseClient } from "../database/client";
import { PolymarketMarket, Position, MarketSession } from "../types";
import { DateTime } from 'luxon';

export class TradingBot {
  private config: BotConfig;
  private dataProvider: BinanceWebSocketDataProvider;
  private polymarket: PolymarketClient;
  private rebalancingEngine: RebalancingEngine;
  private db: DatabaseClient;

  private activeSessions: Map<string, MarketSession> = new Map();
  private rebalanceTimers: Map<string, NodeJS.Timeout> = new Map();
  private running: boolean = false;

  constructor(config: BotConfig) {
    this.config = config;
    this.dataProvider = new BinanceWebSocketDataProvider(config);
    this.polymarket = new PolymarketClient(config);
    this.rebalancingEngine = new RebalancingEngine();
    this.db = new DatabaseClient();
  }

  async start(): Promise<void> {
    console.log('\n🤖 Starting Professional Polymarket Rebalancing Bot\n');

    // Test database connection
    const dbHealthy = await this.db.healthCheck();
    if (!dbHealthy) {
      throw new Error('Database connection failed');
    }

    // STEP 1: Subscribe to Binance WebSocket for market feed
    console.log('📊 Step 1: Subscribing to Binance WebSocket...');
    await this.dataProvider.start(this.config.coins);

    // STEP 2: Wait for Binance connection confirmation
    console.log('⏳ Step 2: Waiting for Binance WebSocket connection...');
    const binanceConnected = await this.dataProvider.waitForConnection();
    if (!binanceConnected) {
      throw new Error('Failed to connect to Binance WebSocket');
    }

    // Start Polymarket client
    await this.polymarket.start();

    this.running = true;

    // STEP 3-6: Discover markets, subscribe to Polymarket, and start trading
    await this.initializeMarketsAndTrading();

    console.log('\n✅ Bot is running\n');
  }

  /**
   * Initialize markets and start trading workflow
   * Steps 3-6: Fetch markets → Extract IDs → Subscribe in pairs → Start trading
   */
  private async initializeMarketsAndTrading(initial: boolean = true): Promise<void> {
    console.log('🔍 Step 3: Fetching active markets from Polymarket...');

    const marketPairs: Array<{ coin: string; market: PolymarketMarket; assetId1: string; assetId2: string; endTime: number }> = [];

    // Fetch all active markets
    for (const coin of this.config.coins.filter(c => c.enabled)) {
      const market = await this.polymarket.fetchMarket(coin.polymarketSlug, initial);

      if (market && market.active) {
        const endTime = this.parseMarketEndTime(market.slug);

        if (!endTime) {
          console.log(`⚠️ ${coin.symbol}: Could not parse end time from slug: ${market.slug}`);
          continue;
        }

        const assetIds = JSON.parse(market.clobTokenIds);
        const [assetId1, assetId2] = assetIds;

        marketPairs.push({
          coin: coin.symbol,
          market,
          assetId1,
          assetId2,
          endTime
        });

        console.log(`✅ ${coin.symbol}: ${market.question}`);
        console.log(`   Ends at: ${new Date(endTime).toLocaleString('en-US', { timeZone: 'America/New_York' })} ET`);
        console.log(`   Asset IDs: [${assetId1}, ${assetId2}]`);
      }
    }

    if (marketPairs.length === 0) {
      console.log('⚠️ No active markets found');
      return;
    }

    console.log(`\n📊 Step 4: Extracted ${marketPairs.length * 2} CLOB asset IDs from ${marketPairs.length} markets`);

    // STEP 5: Subscribe to Polymarket WebSocket in pairs (2 IDs at a time)
    console.log('\n📡 Step 5: Subscribing to Polymarket WebSocket in pairs...');
    await this.polymarket.subscribeInPairs(marketPairs.map(mp => ({
      coin: mp.coin,
      assetId1: mp.assetId1,
      assetId2: mp.assetId2
    })));

    // Wait for orderbook data
    await this.sleep(5000);

    // STEP 6: Start trading
    console.log('\n🎯 Step 6: Starting trading logic...');

    for (const { coin, market, endTime } of marketPairs) {
      const coinConfig = this.config.coins.find(c => c.symbol === coin);
      if (!coinConfig) continue;

      const session: MarketSession = {
        coin,
        market,
        startTime: Date.now(),
        endTime,
        active: true,
      };

      this.activeSessions.set(coin, session);

      // Check if we already have an open position for this market
      const existingPosition = await this.db.getActivePositionForMarket(coin, market.slug);

      if (existingPosition) {
        console.log(`   📍 ${coin}: Resuming existing position: ${existingPosition.id}`);
        session.positionId = existingPosition.id;
        this.startRebalancing(existingPosition, session);
      } else {
        await this.enterInitialPositionWithRetry(coinConfig, session);
      }
    }

    // Schedule market refresh 5 minutes before the earliest market ends
    if (marketPairs.length > 0) {
      const earliestEndTime = Math.min(...marketPairs.map(mp => mp.endTime));
      this.scheduleMarketRefresh(earliestEndTime);
    }
  }

  /**
   * Schedule market refresh to run 5 minutes before market ends
   */
  private scheduleMarketRefresh(marketEndTime: number): void {
    const refreshTime = marketEndTime - (5 * 60 * 1000); // 5 minutes before end
    const now = Date.now();
    const delay = refreshTime - now;

    if (delay <= 0) {
      console.log('⚠️ Market end time already passed or too close, skipping refresh schedule');
      return;
    }

    const endTimeStr = new Date(marketEndTime).toLocaleString('en-US', { timeZone: 'America/New_York' });
    const refreshTimeStr = new Date(refreshTime).toLocaleString('en-US', { timeZone: 'America/New_York' });

    console.log(`\n⏰ Market refresh scheduled:`);
    console.log(`   Market ends: ${endTimeStr} ET`);
    console.log(`   Refresh at: ${refreshTimeStr} ET (5 minutes before)`);
    console.log(`   Time until refresh: ${Math.floor(delay / 60000)} minutes`);

    setTimeout(async () => {
      if (!this.running) return;

      console.log('\n🔄 Market refresh triggered - fetching new active markets...');
      await this.initializeMarketsAndTrading(false);
    }, delay);
  }

  /**
   * Parse market slug to determine end time in ET
   */

  private parseMarketEndTime(slug: string): number | null {
    try {
      const parts = slug.toLowerCase().split('-');

      // months array
      const months = [
        'january', 'february', 'march', 'april', 'may', 'june',
        'july', 'august', 'september', 'october', 'november', 'december'
      ];

      let monthIndex: number | null = null;
      let dayNum: number | null = null;
      let hourNum: number | null = null;
      let meridiem: 'am' | 'pm' | null = null;

      // find month and day (day may be in same part or next part; supports '16' or '16th')
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];

        const mIdx = months.indexOf(p);
        if (mIdx !== -1) {
          monthIndex = mIdx;
          // try next part for day
          if (i + 1 < parts.length) {
            const next = parts[i + 1].match(/\d+/);
            if (next) dayNum = parseInt(next[0], 10);
          }
        }

        // Sometimes the month and day appear like "january-16" or "january-16th" - handled above.
        // Also allow a standalone day anywhere (fallback)
        if (dayNum === null) {
          const dayMatch = p.match(/^(\d{1,2})(st|nd|rd|th)?$/);
          if (dayMatch) dayNum = parseInt(dayMatch[1], 10);
        }

        // time like "6am", "11pm", "12pm"
        const timeMatch = p.match(/^(\d{1,2})(am|pm)$/);
        if (timeMatch) {
          hourNum = parseInt(timeMatch[1], 10);
          meridiem = timeMatch[2] as 'am' | 'pm';
        }
      }

      if (monthIndex === null || dayNum === null || hourNum === null || meridiem === null) {
        return null;
      }

      // convert start to 24-hour hour (0-23)
      // 12am -> 0, 12pm -> 12, otherwise:
      let start24 = hourNum % 12;
      if (meridiem === 'pm') start24 += 12; // e.g., 1pm -> 13

      // end hour in 24-hour space
      const end24 = (start24 + 1) % 24;

      // if end24 <= start24 then it rolled to the next day (e.g., 23 -> 0)
      let endDay = dayNum;
      if (end24 <= start24) {
        endDay = dayNum + 1;
      }

      const year = new Date().getFullYear();

      const endTime = DateTime.fromObject({
        year,
        month: monthIndex + 1,
        day: endDay,
        hour: end24,
        minute: 0,
        second: 0,
        millisecond: 0
      }, { zone: 'America/New_York' });

      return endTime.toMillis();
    } catch (error) {
      console.error('Error parsing market end time:', error);
      return null;
    }
  }

  /**
   * Enter initial position with retry logic
   */
  private async enterInitialPositionWithRetry(
    coin: CoinConfig,
    session: MarketSession,
    maxRetries: number = 10
  ): Promise<void> {
    let attempt = 0;
    let success = false;

    while (attempt < maxRetries && !success && this.running) {
      attempt++;

      try {
        console.log(`\n🎯 Attempting to enter position for ${coin.symbol} (Attempt ${attempt}/${maxRetries})`);

        await this.enterInitialPosition(coin, session);
        success = true;

        console.log(`✅ Successfully entered position for ${coin.symbol}`);
      } catch (error) {
        console.error(`❌ Failed to enter position for ${coin.symbol} (Attempt ${attempt}/${maxRetries}):`, error);

        if (attempt < maxRetries) {
          const delay = Math.min(5000 * attempt, 30000); // Exponential backoff up to 30s
          console.log(`⏳ Retrying in ${delay / 1000} seconds...`);
          await this.sleep(delay);
        } else {
          console.error(`🚫 Max retries reached for ${coin.symbol}. Giving up on this market.`);
          session.active = false;

          // Unsubscribe since we are giving up
          this.polymarket.unsubscribeFromMarket(coin.symbol);
        }
      }
    }
  }

  /**
   * Enter initial position at start of market
   */
  private async enterInitialPosition(coin: CoinConfig, session: MarketSession): Promise<void> {
    const marketData = this.dataProvider.getMarketData(coin.symbol);

    if (!marketData) {
      throw new Error(`No market data available for ${coin.symbol}`);
    }

    const assetIds = JSON.parse(session.market.clobTokenIds);
    const [upAssetId, downAssetId] = assetIds;

    const upBook = this.polymarket.getOrderBook(upAssetId);
    const downBook = this.polymarket.getOrderBook(downAssetId);

    if (!upBook || !downBook) {
      throw new Error(`No orderbook data for ${coin.symbol}`);
    }

    // Determine initial direction based on price momentum
    const side = marketData.priceChange5m > 0 ? 'UP' : 'DOWN';
    const entryPrice = side === 'UP' ? upBook.bestAsk : downBook.bestAsk;
    const tokenId = side === 'UP' ? upAssetId : downAssetId;

    // Validate entry price
    if (entryPrice <= 0 || entryPrice >= 1) {
      throw new Error(`Invalid entry price: ${entryPrice}`);
    }

    // Calculate position size
    const sizeUSDC = this.config.trading.maxPositionSizeUSDC;
    const shares = Math.floor(sizeUSDC / entryPrice);

    const costBasis = shares * entryPrice;

    console.log(`\n💡 ${coin.symbol}: Entering ${side} position`);
    console.log(`   Price: $${marketData.price.toFixed(2)}`);
    console.log(`   Entry: ${side} @ ${entryPrice.toFixed(4)} x ${shares} = $${costBasis.toFixed(2)}`);

    // COMMENTED OUT - Real order execution
    // const success = await this.polymarket.buyShares(tokenId, shares, entryPrice);

    // Simulate success for database logging
    const success = true;

    if (success) {
      const position: Position = {
        id: `${coin.symbol}_${Date.now()}`,
        coin: coin.symbol,
        marketId: session.market.id,
        marketSlug: session.market.slug,
        side,
        entryPrice,
        shares,
        costBasis,
        entryTime: Date.now(),
        hourOpenPrice: marketData.price,
        marketEndTime: session.endTime,
        status: 'OPEN',
        assetIds: {
          up: upAssetId,
          down: downAssetId,
        },
        confidence: 60,
        upBalance: side === 'UP' ? shares : 0,
        downBalance: side === 'DOWN' ? shares : 0,
      };

      await this.db.insertPosition(position);

      await this.db.insertTrade({
        positionId: position.id,
        coin: coin.symbol,
        side,
        action: 'BUY',
        tokenId,
        shares,
        price: entryPrice,
        cost: costBasis,
        currentPrice: marketData.price,
        upBalance: position.upBalance!,
        downBalance: position.downBalance!,
        imbalance: Math.abs(position.upBalance! - position.downBalance!),
        reason: 'Initial position entry',
        executed: false, // Set to false since real trading is commented out
      });

      session.positionId = position.id;

      console.log(`✅ Position opened: ${position.id}`);

      // Start rebalancing loop
      this.startRebalancing(position, session);
    } else {
      throw new Error('Failed to execute buy order');
    }
  }

  /**
   * Start continuous rebalancing for a position
   */
  private startRebalancing(position: Position, session: MarketSession): void {
    console.log(`\n⚖️ Starting rebalancing for ${position.coin}`);

    const timer = setInterval(async () => {
      if (!this.running) {
        clearInterval(timer);
        return;
      }

      const now = Date.now();
      const timeRemaining = session.endTime - now;
      const minutesRemaining = Math.floor(timeRemaining / 60000);

      // Stop if market ended
      if (timeRemaining <= 0) {
        console.log(`\n⏰ Market ended for ${position.coin}`);
        await this.closePosition(position, session);
        clearInterval(timer);
        this.rebalanceTimers.delete(position.coin);
        return;
      }

      await this.executeRebalancing(position, session, minutesRemaining);
    }, 10000); // Check every 10 seconds

    this.rebalanceTimers.set(position.coin, timer);
  }

  /**
   * Execute rebalancing logic
   */
  private async executeRebalancing(
    position: Position,
    session: MarketSession,
    minutesRemaining: number
  ): Promise<void> {
    // Fetch latest position from DB
    const latestPosition = await this.db.getPosition(position.id);
    if (!latestPosition) return;

    const marketData = this.dataProvider.getMarketData(position.coin);
    if (!marketData) return;

    const upBook = this.polymarket.getOrderBook(position.assetIds.up);
    const downBook = this.polymarket.getOrderBook(position.assetIds.down);

    if (!upBook || !downBook) return;

    // Evaluate rebalancing decision
    const decision = this.rebalancingEngine.evaluateRebalancing(
      latestPosition,
      marketData,
      upBook,
      downBook
    );

    if (decision.shouldRebalance && decision.action && decision.shares && decision.targetPrice) {
      console.log(`\n⚖️ REBALANCING ${position.coin}`);
      console.log(`   Action: ${decision.action}`);
      console.log(`   Shares: ${decision.shares}`);
      console.log(`   Target: $${decision.targetPrice.toFixed(4)}`);
      console.log(`   Reason: ${decision.reason}`);
      console.log(`   Time remaining: ${minutesRemaining}m`);

      await this.executeRebalanceTrade(latestPosition, decision, marketData.price);
    }

    // Save market snapshot
    await this.db.insertSnapshot({
      coin: position.coin,
      marketSlug: session.market.slug,
      price: marketData.price,
      priceChange1m: marketData.priceChange1m,
      priceChange5m: marketData.priceChange5m,
      priceChange15m: marketData.priceChange15m,
      volatility: marketData.volatility,
      upBestBid: upBook.bestBid,
      upBestAsk: upBook.bestAsk,
      downBestBid: downBook.bestBid,
      downBestAsk: downBook.bestAsk,
      spread: upBook.spread + downBook.spread,
      timestamp: Date.now(),
    });
  }

  /**
   * Execute a rebalancing trade
   */
  private async executeRebalanceTrade(
    position: Position,
    decision: any,
    currentPrice: number
  ): Promise<void> {
    const action = decision.action;
    const shares = decision.shares!;
    const price = decision.targetPrice!;

    const side = action.includes('UP') ? 'UP' : 'DOWN';
    const tokenId = side === 'UP' ? position.assetIds.up : position.assetIds.down;
    const cost = shares * price;

    // COMMENTED OUT - Real order execution
    // const success = await this.polymarket.buyShares(tokenId, shares, price);

    // Simulate success for database logging
    const success = true;

    // Update balances
    const newUpBalance = (position.upBalance || 0) + (side === 'UP' ? shares : 0);
    const newDownBalance = (position.downBalance || 0) + (side === 'DOWN' ? shares : 0);

    if (success) {
      // Update position in database
      await this.db.updatePosition(position.id, {
        upBalance: newUpBalance,
        downBalance: newDownBalance,
        costBasis: position.costBasis + cost,
      });

      // Log trade
      await this.db.insertTrade({
        positionId: position.id,
        coin: position.coin,
        side,
        action: 'BUY',
        tokenId,
        shares,
        price,
        cost,
        currentPrice,
        upBalance: newUpBalance,
        downBalance: newDownBalance,
        imbalance: Math.abs(newUpBalance - newDownBalance),
        reason: decision.reason,
        executed: false, // Set to false since real trading is commented out
      });

      // Update in-memory position
      position.upBalance = newUpBalance;
      position.downBalance = newDownBalance;
      position.costBasis += cost;

      console.log(`✅ Rebalance executed`);
      console.log(`   UP: ${newUpBalance} | DOWN: ${newDownBalance} | Imbalance: ${Math.abs(newUpBalance - newDownBalance)}`);
    }
  }

  /**
   * Close position at market end
   */
  private async closePosition(position: Position, session: MarketSession): Promise<void> {
    const upBalance = position.upBalance || 0;
    const downBalance = position.downBalance || 0;
    const balancedShares = Math.min(upBalance, downBalance);

    // Calculate final P&L
    const totalPayout = balancedShares * 1.0; // $1 per matched pair
    const pnl = totalPayout - position.costBasis;

    console.log(`\n💰 CLOSING ${position.coin}`);
    console.log(`   UP Balance: ${upBalance}`);
    console.log(`   DOWN Balance: ${downBalance}`);
    console.log(`   Balanced Shares: ${balancedShares}`);
    console.log(`   Cost Basis: $${position.costBasis.toFixed(2)}`);
    console.log(`   Payout: $${totalPayout.toFixed(2)}`);
    console.log(`   P&L: $${pnl.toFixed(2)}`);

    await this.db.updatePosition(position.id, {
      status: 'CLOSED',
      exitTime: Date.now(),
      pnl,
    });

    await this.db.updateSessionStats();

    session.active = false;

    // Unsubscribe from this market's assets
    this.polymarket.unsubscribeFromMarket(position.coin);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async getStats() {
    return await this.db.getStats();
  }

  async stop(): Promise<void> {
    console.log('\n🛑 Stopping bot...');

    this.running = false;

    // Clear all rebalance timers
    for (const timer of this.rebalanceTimers.values()) {
      clearInterval(timer);
    }

    await this.dataProvider.stop();
    this.polymarket.stop();

    const stats = await this.getStats();
    console.log('\n📊 Final Stats:', stats);

    await this.db.close();

    console.log('\n✅ Bot stopped');
  }
}
