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
  subscribeToMarket(coin: string, assetId1: string, assetId2: string): void {
    console.log(`📡 Subscribing to ${coin} market: ${assetId1}, ${assetId2}`);

    // Store the asset IDs for this coin
    this.marketAssetIds.set(coin, { assetId1, assetId2 });

    // Connect WebSocket with both asset IDs
    this.ws.connect(assetId1, assetId2);
  }

  /**
   * Subscribe to order books for a pair of asset IDs (2 at a time)
   */
  subscribeToOrderBooks(assetId1: string, assetId2: string): void {
    console.log(`📡 Subscribing to Polymarket pair: [${assetId1}, ${assetId2}]`);

    // Connect WebSocket with both asset IDs
    this.ws.connect(assetId1, assetId2);
  }

  /**
   * Subscribe to multiple markets in pairs
   * Each market has 2 asset IDs (UP and DOWN tokens)
   */
  subscribeInPairs(marketAssetPairs: Array<{ assetId1: string; assetId2: string; coin: string }>): void {
    console.log(`📡 Subscribing to ${marketAssetPairs.length} Polymarket market pairs...`);

    for (const pair of marketAssetPairs) {
      console.log(`   - ${pair.coin}: [${pair.assetId1}, ${pair.assetId2}]`);
      this.ws.connect(pair.assetId1, pair.assetId2);
    }

    console.log(`✅ Subscribed to ${marketAssetPairs.length} market pairs`);
  }


  async fetchMarket(slugPrefix: string): Promise<PolymarketMarket | null> {
    try {
      const now = new Date();

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

      const order = await this.clobClient.createOrder({
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

      const order = await this.clobClient.createOrder({
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
