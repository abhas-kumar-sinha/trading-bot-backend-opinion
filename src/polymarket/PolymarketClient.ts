// ============================================================================
// 4. POLYMARKET CLIENT (src/polymarket/PolymarketClient.ts)
// ============================================================================

import { ClobClient, Chain, Side } from '@polymarket/clob-client';
import { Wallet } from 'ethers';
import axios from 'axios';
import WebSocket from 'ws';
import { OrderBookData, PolymarketMarket } from '../types';
import { BotConfig } from '../config';

export class PolymarketClient {
  private clobClient: ClobClient;
  private gammaApiUrl: string;
  private ws: WebSocket | null = null;
  private wsUrl: string;
  private orderBooks: Map<string, OrderBookData> = new Map();
  private subscribedAssets: Set<string> = new Set();

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
    this.wsUrl = config.polymarket.wsUrl;
  }

  async start(): Promise<void> {
    console.log('🔗 Connecting to Polymarket...');
    this.connectWebSocket();
    console.log('✅ Polymarket client started');
  }

  private connectWebSocket(): void {
    this.ws = new WebSocket(this.wsUrl);

    this.ws.on('open', () => {
      console.log('✅ Polymarket WebSocket connected');
      this.resubscribeAll();
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      this.handleMessage(data);
    });

    this.ws.on('error', (error: Error) => {
      console.error('❌ Polymarket WS error:', error);
    });

    this.ws.on('close', () => {
      console.log('⚠️ Polymarket WS closed, reconnecting...');
      setTimeout(() => this.connectWebSocket(), 5000);
    });
  }

  private resubscribeAll(): void {
    if (this.subscribedAssets.size > 0) {
      const assets = Array.from(this.subscribedAssets);
      this.subscribedAssets.clear();
      this.subscribeToOrderBooks(assets);
    }
  }

  private handleMessage(data: WebSocket.Data): void {
    try {
      const text = data.toString();

      // Polymarket sometimes sends plain text errors
      if (!text.startsWith("{")) {
          return;
      }

      let msg: any;
      try {
          msg = JSON.parse(text);
      } catch (err) {
          console.error("❌ Failed to parse Polymarket JSON:", text);
          return;
      }

      if (msg.event_type === 'book') {
        const bids = msg.bids?.map((b: any) => ({ 
          price: parseFloat(b.price), 
          size: parseFloat(b.size) 
        })) || [];
        const asks = msg.asks?.map((a: any) => ({ 
          price: parseFloat(a.price), 
          size: parseFloat(a.size) 
        })) || [];

        const bestBid = bids[0]?.price || 0;
        const bestAsk = asks[0]?.price || 1;

        this.orderBooks.set(msg.asset_id, {
          assetId: msg.asset_id,
          bids,
          asks,
          bestBid,
          bestAsk,
          spread: bestAsk - bestBid,
          mid: (bestBid + bestAsk) / 2,
        });
      }
    } catch (error) {
      console.error('Error parsing Polymarket message:', error);
    }
  }

  subscribeToOrderBooks(assetIds: string[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      setTimeout(() => this.subscribeToOrderBooks(assetIds), 1000);
      return;
    }

    const newAssets = assetIds.filter(id => !this.subscribedAssets.has(id));
    if (newAssets.length === 0) return;

    this.ws.send(JSON.stringify({
      assets_ids: newAssets,
      type: 'market',
    }));

    newAssets.forEach(id => this.subscribedAssets.add(id));
    console.log(`📡 Subscribed to ${newAssets.length} Polymarket assets`);
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

  getOrderBook(assetId: string): OrderBookData | null {
    return this.orderBooks.get(assetId) || null;
  }

  stop(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    console.log('✅ Polymarket client stopped');
  }
}
