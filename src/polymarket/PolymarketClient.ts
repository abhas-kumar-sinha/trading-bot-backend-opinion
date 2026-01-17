// ============================================================================
// 4. POLYMARKET CLIENT (src/polymarket/PolymarketClient.ts)
// ============================================================================

import { ClobClient, Chain, Side } from '@polymarket/clob-client';
import { Wallet } from 'ethers';
import axios from 'axios';
import { OrderBookData, PolymarketMarket } from '../types';
import { BotConfig } from '../config';
import { PolymarketWebSocket } from './websocket';

export class PolymarketClient {
  private clobClient: ClobClient;
  private gammaApiUrl: string;
  private ws: PolymarketWebSocket;
  private marketAssetIds: Map<string, { assetId1: string; assetId2: string }> = new Map();

  constructor(config: BotConfig) {
    const wallet = new Wallet(config.polymarket.privateKey);

    this.clobClient = new ClobClient(
      config.polymarket.host,
      Chain.POLYGON,
      wallet,
      {
        key: config.polymarket.apiKey,
        secret: config.polymarket.apiSecret,
        passphrase: config.polymarket.apiPassphrase,
      }
    );

    this.gammaApiUrl = config.polymarket.gammaApiUrl;
    this.ws = new PolymarketWebSocket();
  }

  async start(): Promise<void> {
    console.log('🔗 Connecting to Polymarket...');
    console.log('✅ Polymarket client started');
  }

  /**
   * Subscribe to order books for a specific market's asset IDs
   */
  async subscribeToMarket(coin: string, assetId1: string, assetId2: string): Promise<boolean> {
    console.log(`📡 Subscribing to ${coin} market: ${assetId1.slice(0, 8)}..., ${assetId2.slice(0, 8)}...`);

    // Store the asset IDs for this coin
    this.marketAssetIds.set(coin, { assetId1, assetId2 });

    // Connect WebSocket with both asset IDs
    this.ws.connect([assetId1, assetId2]);

    // Wait for orderbook data to arrive
    const success = await this.ws.waitForOrderbookData(assetId1, assetId2);
    
    if (success) {
      console.log(`✅ ${coin} orderbook connected and ready`);
    } else {
      console.error(`❌ ${coin} orderbook failed to connect`);
    }

    return success;
  }

  /**
   * Subscribe to order books for a pair of asset IDs (2 at a time)
   */
  async subscribeToOrderBooks(assetId1: string, assetId2: string): Promise<boolean> {
    console.log(`📡 Subscribing to Polymarket pair: [${assetId1.slice(0, 8)}..., ${assetId2.slice(0, 8)}...]`);

    // Connect WebSocket with both asset IDs
    this.ws.connect([assetId1, assetId2]);

    // Wait for orderbook data to arrive
    const success = await this.ws.waitForOrderbookData(assetId1, assetId2);
    
    if (success) {
      console.log(`✅ Orderbook pair connected and ready`);
    } else {
      console.error(`❌ Orderbook pair failed to connect`);
    }

    return success;
  }

  /**
   * Subscribe to multiple markets in pairs
   * Each market has 2 asset IDs (UP and DOWN tokens)
   * 
   * CRITICAL: Polymarket's WebSocket replaces subscriptions on each call.
   * Solution: Add all assets first, subscribe once, then wait for each pair's data
   * 
   * For market refresh: Completely reconnect the WebSocket with new assets
   */
  async subscribeInPairs(marketAssetPairs: Array<{ assetId1: string; assetId2: string; coin: string }>, isRefresh: boolean = false): Promise<void> {
    console.log(`📡 Subscribing to ${marketAssetPairs.length} Polymarket market pairs...`);

    // Step 0: If this is a refresh, clear old market tracking
    if (isRefresh) {
      console.log(`🔄 Market refresh detected - clearing old market data...`);
      this.marketAssetIds.clear();
    }

    // Step 1: Collect ALL asset IDs from all markets
    const allAssetIds: string[] = [];
    for (const pair of marketAssetPairs) {
      this.marketAssetIds.set(pair.coin, { assetId1: pair.assetId1, assetId2: pair.assetId2 });
      allAssetIds.push(pair.assetId1, pair.assetId2);
    }

    // Step 2: Connect to WebSocket - full reconnect if refresh
    if (isRefresh) {
      console.log(`📡 Performing full WebSocket reconnection with ${allAssetIds.length} new assets...`);
      await this.ws.reconnect(allAssetIds);
    } else {
      console.log(`📡 Connecting to WebSocket with ${allAssetIds.length} total assets...`);
      this.ws.connect(allAssetIds, false);
    }

    // Step 3: Wait for each market pair's data sequentially
    for (let i = 0; i < marketAssetPairs.length; i++) {
      const pair = marketAssetPairs[i];
      console.log(`   - ${pair.coin}: [${pair.assetId1.slice(0, 8)}..., ${pair.assetId2.slice(0, 8)}...]`);
      
      // Wait for orderbook data for this specific pair
      console.log(`⏳ Waiting for ${pair.coin} orderbook data...`);
      const success = await this.ws.waitForOrderbookData(pair.assetId1, pair.assetId2, 30000);

      if (success) {
        console.log(`✅ ${pair.coin} orderbook ready (${i + 1}/${marketAssetPairs.length})`);
      } else {
        console.error(`❌ ${pair.coin} orderbook failed - continuing to next market`);
      }
    }

    console.log(`✅ All ${marketAssetPairs.length} market pairs subscribed and ready`);
  }

  /**
   * Unsubscribe from order books for a specific market's asset IDs
   */
  unsubscribeFromMarket(coin: string): void {
    const assets = this.marketAssetIds.get(coin);
    if (assets) {
      console.log(`📡 Unsubscribing from ${coin} market: ${assets.assetId1.slice(0, 8)}..., ${assets.assetId2.slice(0, 8)}...`);
      this.ws.unsubscribe([assets.assetId1, assets.assetId2]);
      this.marketAssetIds.delete(coin);
    } else {
      console.warn(`⚠️ unsubscribeFromMarket: No assets found for ${coin} in map`);
    }
  }

  /**
   * Unsubscribe from specific pair of asset IDs
   */
  unsubscribeFromPair(assetId1: string, assetId2: string): void {
    console.log(`📡 Unsubscribing from Polymarket pair: [${assetId1.slice(0, 8)}..., ${assetId2.slice(0, 8)}...]`);
    this.ws.unsubscribe([assetId1, assetId2]);
  }

  async fetchMarket(slugPrefix: string, initial: boolean = true): Promise<PolymarketMarket | null> {
    try {
      const now = new Date();

      if (!initial) {
        now.setTime(now.getTime() + 1 * 60 * 60 * 1000);
      }

      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        month: "long",
        day: "numeric",
        hour: "numeric",
        hour12: true,
      }).formatToParts(now);

      const get = (type: string) =>
        parts.find(p => p.type === type)?.value!;

      const month = get("month").toLowerCase();
      const day = get("day");
      const hour = get("hour");
      const ampm = get("dayPeriod").toLowerCase();

      const slug = `${slugPrefix}-${month}-${day}-${hour}${ampm}-et`;

      const response = await axios.get(
        `${this.gammaApiUrl}/markets/slug/${slug}`
      );

      return response.data;
    } catch (error) {
      console.error(`Failed to fetch market ${slugPrefix}:`, error);
      return null;
    }
  }

  async buyShares(tokenId: string, amount: number, maxPrice: number): Promise<boolean> {
    try {
      console.log(`📝 BUYING ${amount} shares @ max $${maxPrice.toFixed(4)}`);

      const order = await this.clobClient.createAndPostOrder({
        tokenID: tokenId,
        price: maxPrice,
        size: amount,
        side: Side.BUY,
        feeRateBps: 0,
      });

      console.log(`✅ Buy order placed:`, order);
      return true;
    } catch (error) {
      console.error(`❌ Buy order failed:`, error);
      return false;
    }
  }

  async sellShares(tokenId: string, amount: number, minPrice: number): Promise<boolean> {
    try {
      console.log(`📝 SELLING ${amount} shares @ min $${minPrice.toFixed(4)}`);

      const order = await this.clobClient.createAndPostOrder({
        tokenID: tokenId,
        price: minPrice,
        size: amount,
        side: Side.SELL,
        feeRateBps: 0,
      });

      console.log(`✅ Sell order placed:`, order);
      return true;
    } catch (error) {
      console.error(`❌ Sell order failed:`, error);
      return false;
    }
  }

  /**
   * Get order book data for a specific asset ID
   */
  getOrderBook(assetId: string): OrderBookData | null {
    const bookData = this.ws.getLatestBookByAssetId(assetId);

    if (!bookData) {
      return null;
    }

    const bestBid = parseFloat(bookData.bestBid);
    const bestAsk = parseFloat(bookData.bestAsk);

    return {
      assetId,
      bids: [{ price: bestBid, size: 0 }],
      asks: [{ price: bestAsk, size: 0 }],
      bestBid,
      bestAsk,
      spread: bestAsk - bestBid,
      mid: (bestBid + bestAsk) / 2,
    };
  }

  stop(): void {
    this.ws.disconnect();
    console.log('✅ Polymarket client stopped');
  }
}
