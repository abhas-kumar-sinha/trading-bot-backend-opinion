// ============================================================================
// MAIN BOT WITH REBALANCING (src/core/TradingBot.ts)
// ============================================================================

import { BotConfig, CoinConfig } from "../config";
import { BinanceWebSocketDataProvider } from "../data/WebSocketDataProvider";
import { PolymarketClient } from "../polymarket/PolymarketClient";
import { RebalancingEngine } from "../strategy/RebalancingEngine";
import { DatabaseClient } from "../database/client";
import { OrderBookData, PolymarketMarket, Position, MarketSession } from "../types";
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
    this.rebalancingEngine = new RebalancingEngine(config);
    this.db = new DatabaseClient();
  }

  async start(): Promise<void> {
    console.log('\n🤖 Starting Professional Polymarket Rebalancing Bot\n');

    // Test database connection
    const dbHealthy = await this.db.healthCheck();
    if (!dbHealthy) {
      throw new Error('Database connection failed');
    }

    await this.dataProvider.start(this.config.coins);
    await this.polymarket.start();
    
    this.running = true;

    // Start market discovery and monitoring
    await this.discoverActiveMarkets();
    this.startMarketDiscoveryLoop();

    console.log('\n✅ Bot is running\n');
  }

  /**
   * Parse market slug to determine end time in ET
   */
  private parseMarketEndTime(slug: string): number | null {
    try {
      // Example: bitcoin-up-or-down-january-16-6am-et
      const parts = slug.split('-');
      
      // Find the month, day, and time
      let month: string | null = null;
      let day: number | null = null;
      let hour: number | null = null;
      let isPM = false;

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i].toLowerCase();
        
        // Check for month names
        const months = ['january', 'february', 'march', 'april', 'may', 'june', 
                       'july', 'august', 'september', 'october', 'november', 'december'];
        if (months.includes(part)) {
          month = part;
          if (i + 1 < parts.length && !isNaN(parseInt(parts[i + 1]))) {
            day = parseInt(parts[i + 1]);
          }
        }

        // Check for time (e.g., "6am", "11pm")
        if (part.endsWith('am') || part.endsWith('pm')) {
          isPM = part.endsWith('pm');
          hour = parseInt(part.replace(/[ap]m/, ''));
        }
      }

      if (!month || day === null || hour === null) {
        return null;
      }

      // Convert to actual end time (add 1 hour to start time)
      let endHour = hour + 1;
      if (endHour === 12 && !isPM) endHour = 12; // 11am -> 12pm
      if (endHour === 13) { endHour = 1; isPM = true; } // 12pm -> 1pm
      if (endHour === 24) endHour = 0; // 11pm -> 12am (midnight)

      // Build the end time in ET
      const year = new Date().getFullYear();
      const monthIndex = ['january', 'february', 'march', 'april', 'may', 'june',
                         'july', 'august', 'september', 'october', 'november', 'december']
                         .indexOf(month);

      const endTime = DateTime.fromObject({
        year,
        month: monthIndex + 1,
        day,
        hour: endHour + (isPM && endHour !== 12 ? 12 : 0) - (endHour === 12 && !isPM ? 12 : 0),
        minute: 0,
        second: 0,
      }, { zone: 'America/New_York' });

      return endTime.toMillis();
    } catch (error) {
      console.error('Error parsing market end time:', error);
      return null;
    }
  }

  /**
   * Discover currently active markets
   */
  private async discoverActiveMarkets(): Promise<void> {
    console.log('🔍 Discovering active markets...');

    for (const coin of this.config.coins.filter(c => c.enabled)) {
      const market = await this.polymarket.fetchMarket(coin.polymarketSlug);
      
      if (market && market.active) {
        const endTime = this.parseMarketEndTime(market.slug);
        
        if (!endTime) {
          console.log(`⚠️ ${coin.symbol}: Could not parse end time from slug: ${market.slug}`);
          continue;
        }

        const now = Date.now();
        const timeUntilEnd = endTime - now;

        // Only process markets that end within the next 2 hours
        if (timeUntilEnd > 0 && timeUntilEnd < 7200000) {
          const assetIds = JSON.parse(market.clobTokenIds);
          this.polymarket.subscribeToOrderBooks(assetIds);

          const session: MarketSession = {
            coin: coin.symbol,
            market,
            startTime: now,
            endTime,
            active: true,
          };

          this.activeSessions.set(coin.symbol, session);

          console.log(`✅ ${coin.symbol}: ${market.question}`);
          console.log(`   Ends at: ${new Date(endTime).toLocaleString('en-US', { timeZone: 'America/New_York' })} ET`);
          console.log(`   Time remaining: ${Math.floor(timeUntilEnd / 60000)} minutes`);

          // Check if we already have an open position for this market
          const existingPosition = await this.db.getActivePositionForMarket(coin.symbol, market.slug);
          
          if (existingPosition) {
            console.log(`   📍 Resuming existing position: ${existingPosition.id}`);
            session.positionId = existingPosition.id;
            this.startRebalancing(existingPosition, session);
          } else {
            // Wait for orderbook data before entering
            await this.sleep(2000);
            await this.enterInitialPositionWithRetry(coin, session);
          }
        }
      }
    }
  }

  /**
   * Continuously discover new markets
   */
  private startMarketDiscoveryLoop(): void {
    setInterval(async () => {
      if (!this.running) return;

      for (const coin of this.config.coins.filter(c => c.enabled)) {
        const existingSession = this.activeSessions.get(coin.symbol);
        
        // Skip if we already have an active session
        if (existingSession && existingSession.active) continue;

        const market = await this.polymarket.fetchMarket(coin.polymarketSlug);
        
        if (market && market.active) {
          const endTime = this.parseMarketEndTime(market.slug);
          
          if (endTime && endTime > Date.now()) {
            console.log(`\n🆕 New market discovered for ${coin.symbol}`);
            await this.discoverActiveMarkets();
            break;
          }
        }
      }
    }, 60000); // Check every minute
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

    if (shares < 1) {
      throw new Error(`Position size too small: ${shares} shares`);
    }

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
