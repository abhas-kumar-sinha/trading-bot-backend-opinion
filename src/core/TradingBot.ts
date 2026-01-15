// ============================================================================
// 7. MAIN BOT (src/core/TradingBot.ts)
// ============================================================================

import { BotConfig, CoinConfig } from "../config";
import { CCXTDataProvider } from "../data/CCXTDataProvider";
import { PolymarketClient } from "../polymarket/PolymarketClient";
import { PredictionEngine } from "../strategy/PredictionEngine";
import { PositionManager } from "../trading/PositionManager";
import { OrderBookData, PolymarketMarket, Position, TradeSignal } from "../types";

export class TradingBot {
  private config: BotConfig;
  private dataProvider: CCXTDataProvider;
  private polymarket: PolymarketClient;
  private predictionEngine: PredictionEngine;
  private positionManager: PositionManager;
  private markets: Map<string, PolymarketMarket> = new Map();
  private predictionTimer?: NodeJS.Timeout;
  private monitorTimer?: NodeJS.Timeout;

  constructor(config: BotConfig) {
    this.config = config;
    this.dataProvider = new CCXTDataProvider(config);
    this.polymarket = new PolymarketClient(config);
    this.predictionEngine = new PredictionEngine();
    this.positionManager = new PositionManager(config);
  }

  async start(): Promise<void> {
    console.log('\n🤖 Starting Professional Polymarket Bot\n');

    await this.dataProvider.start(this.config.coins);
    await this.polymarket.start();
    
    await this.updateMarkets();
    
    this.schedulePredictions();
    this.startMonitoring();

    console.log('\n✅ Bot is running\n');
  }

  private async updateMarkets(): Promise<void> {
    console.log('🔄 Fetching Polymarket markets...');
    
    for (const coin of this.config.coins.filter(c => c.enabled)) {
      const market = await this.polymarket.fetchMarket(coin.polymarketSlug);
      if (market) {
        this.markets.set(coin.symbol, market);
        const assetIds = JSON.parse(market.clobTokenIds);
        this.polymarket.subscribeToOrderBooks(assetIds);
        console.log(`✅ ${coin.symbol}: ${market.question}`);
      }
    }
  }

  private schedulePredictions(): void {
    const now = new Date();
    const leadMinutes = this.config.strategy.predictionLeadMinutes;
    const minutesToNext = 60 - now.getMinutes() - leadMinutes;
    const msToNext = minutesToNext * 60 * 1000;

    setTimeout(() => {
      this.makePredictions();
      this.predictionTimer = setInterval(() => this.makePredictions(), 3600000);
    }, msToNext);

    console.log(`⏰ Next predictions in ${minutesToNext} minutes`);
  }

  private async makePredictions(): Promise<void> {
    console.log('\n' + '='.repeat(70));
    console.log('🔮 MAKING PREDICTIONS FOR NEXT HOUR');
    console.log('='.repeat(70) + '\n');

    await this.updateMarkets();

    for (const coin of this.config.coins.filter(c => c.enabled)) {
      await this.processCoin(coin);
    }
  }

  private async processCoin(coin: CoinConfig): Promise<void> {
    const marketData = this.dataProvider.getMarketData(coin.symbol);
    const market = this.markets.get(coin.symbol);

    if (!marketData || !market) {
      console.log(`⚠️ ${coin.symbol}: Missing data`);
      return;
    }

    // Generate trading signal
    const signal = this.predictionEngine.predict(marketData);
    
    if (signal.direction === 'SKIP' || signal.confidence < coin.minConfidence) {
      console.log(`⏸️ ${coin.symbol}: ${signal.direction} (Confidence: ${signal.confidence}%) - SKIPPED`);
      return;
    }

    console.log(`\n💡 ${coin.symbol}: ${signal.direction} (Confidence: ${signal.confidence}%)`);
    signal.reasons.forEach(r => console.log(`   - ${r}`));

    // Check risk limits
    if (!this.positionManager.canOpenNewPosition()) {
      console.log(`⚠️ ${coin.symbol}: Risk limits reached, skipping`);
      return;
    }

    // Get asset IDs and order books
    const assetIds = JSON.parse(market.clobTokenIds);
    const [upAssetId, downAssetId] = assetIds;

    await new Promise(resolve => setTimeout(resolve, 2000));

    const upBook = this.polymarket.getOrderBook(upAssetId);
    const downBook = this.polymarket.getOrderBook(downAssetId);

    if (!upBook || !downBook) {
      console.log(`⚠️ ${coin.symbol}: No order book data`);
      return;
    }

    // Execute entry
    await this.enterPosition(coin, signal, market, upBook, downBook);
  }

  private async enterPosition(
    coin: CoinConfig,
    signal: TradeSignal,
    market: PolymarketMarket,
    upBook: OrderBookData,
    downBook: OrderBookData
  ): Promise<void> {
    const side = signal.direction;
    const entryPrice = side === 'UP' ? upBook.bestAsk : downBook.bestAsk;
    const tokenId = side === 'UP' ? upBook.assetId : downBook.assetId;

    // Calculate position size
    const sizeUSDC = this.positionManager.calculatePositionSize(signal.confidence);
    const shares = Math.floor(sizeUSDC / entryPrice);

    if (shares < 1) {
      console.log(`⚠️ ${coin.symbol}: Position too small (${shares} shares)`);
      return;
    }

    const costBasis = shares * entryPrice;

    console.log(`📊 Entry: ${side} @ ${entryPrice.toFixed(4)} x ${shares} = ${costBasis.toFixed(2)}`);

    // Execute buy order
    const success = await this.polymarket.buyShares(tokenId, shares, entryPrice);

    if (success) {
      const position: Position = {
        id: `${coin.symbol}_${Date.now()}`,
        coin: coin.symbol,
        marketId: market.id,
        side,
        entryPrice,
        shares,
        costBasis,
        entryTime: Date.now(),
        hourOpenPrice: signal.marketData.hourOpen,
        marketEndTime: new Date(market.endDate).getTime(),
        status: 'OPEN',
        assetIds: {
          up: upBook.assetId,
          down: downBook.assetId,
        },
        confidence: signal.confidence,
      };

      this.positionManager.openPosition(position);
    }
  }

  private startMonitoring(): void {
    this.monitorTimer = setInterval(
      () => this.monitorPositions(),
      this.config.strategy.monitorIntervalSeconds * 1000
    );
  }

  private async monitorPositions(): Promise<void> {
    const positions = this.positionManager.getOpenPositions();
    
    for (const position of positions) {
      await this.monitorPosition(position);
    }
  }

  private async monitorPosition(position: Position): Promise<void> {
    const marketData = this.dataProvider.getMarketData(position.coin);
    if (!marketData) return;

    const upBook = this.polymarket.getOrderBook(position.assetIds.up);
    const downBook = this.polymarket.getOrderBook(position.assetIds.down);

    if (!upBook || !downBook) return;

    const action = this.positionManager.evaluatePosition(
      position,
      marketData.price,
      upBook.bestAsk,
      downBook.bestAsk
    );

    if (action === 'HEDGE') {
      await this.hedgePosition(position, upBook, downBook);
    } else if (action === 'STOP_LOSS') {
      await this.stopLossPosition(position, upBook, downBook);
    }
  }

  private async hedgePosition(
    position: Position,
    upBook: OrderBookData,
    downBook: OrderBookData
  ): Promise<void> {
    const oppositeSide = position.side === 'UP' ? 'DOWN' : 'UP';
    const hedgeTokenId = position.side === 'UP' ? position.assetIds.down : position.assetIds.up;
    const hedgePrice = position.side === 'UP' ? downBook.bestAsk : upBook.bestAsk;

    console.log(`\n🔒 HEDGING ${position.coin} ${position.side} → ${oppositeSide} @ ${hedgePrice.toFixed(4)}`);

    const success = await this.polymarket.buyShares(hedgeTokenId, position.shares, hedgePrice);

    if (success) {
      const profit = this.positionManager.calculateHedgeProfit(position, upBook.bestAsk, downBook.bestAsk);
      
      this.positionManager.updatePosition(position.id, {
        status: 'HEDGED',
        hedgePrice,
        hedgeTime: Date.now(),
        pnl: profit,
      });

      console.log(`💰 PROFIT LOCKED: ${profit.toFixed(2)}`);
    }
  }

  private async stopLossPosition(
    position: Position,
    upBook: OrderBookData,
    downBook: OrderBookData
  ): Promise<void> {
    console.log(`\n🛑 STOP-LOSS ${position.coin} ${position.side}`);

    const sellTokenId = position.side === 'UP' ? position.assetIds.up : position.assetIds.down;
    const sellBook = position.side === 'UP' ? upBook : downBook;
    const sellPrice = sellBook.bestBid;

    const success = await this.polymarket.sellShares(sellTokenId, position.shares, sellPrice);

    if (success) {
      const proceeds = sellPrice * position.shares;
      const loss = proceeds - position.costBasis;
      this.positionManager.closePosition(position.id, sellPrice, loss);
    }
  }

  getStats() {
    return this.positionManager.getStats();
  }

  stop(): void {
    console.log('\n🛑 Stopping bot...');
    
    if (this.predictionTimer) clearInterval(this.predictionTimer);
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    
    this.dataProvider.stop();
    this.polymarket.stop();
    
    console.log('\n📊 Final Stats:', this.getStats());
    console.log('\n✅ Bot stopped');
  }
}
