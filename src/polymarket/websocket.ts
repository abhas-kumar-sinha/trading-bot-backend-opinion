import WebSocket from 'ws';
import { BookMessage } from './types';
import { config } from '../config';

type PolymarketMessage = BookMessage;

export class PolymarketWebSocket {
  private ws: WebSocket | null = null;
  private readonly wsUrl = config.polymarket.wsUrl;
  private allSubscribedAssets: Set<string> = new Set();
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 5;
  private readonly reconnectDelay = 5000;
  private pingInterval: NodeJS.Timeout | null = null;
  private readonly pingIntervalMs = 30000;
  private lastMessageTime = Date.now();

  // Store latest data - keyed by assetId
  private latestBookByAssetId: Map<string, { bestBid: string, bestAsk: string }> = new Map();

  // Track pending subscriptions waiting for first data
  private pendingDataPromises: Map<string, { resolve: () => void, reject: (reason?: any) => void }[]> = new Map();

  /**
   * Connect to WebSocket and subscribe to assets
   */
  public connect(assetIds: string[], replaceExisting: boolean = false): void {
    // If replacing, clear existing assets first
    if (replaceExisting) {
      console.log(`🔄 Replacing ${this.allSubscribedAssets.size} existing assets with ${assetIds.length} new assets`);
      
      // Clear old subscriptions
      this.allSubscribedAssets.clear();
      
      // Clear old orderbook data (but keep pending promises for new assets)
      const newAssetSet = new Set(assetIds);
      this.latestBookByAssetId.forEach((_, assetId) => {
        if (!newAssetSet.has(assetId)) {
          this.latestBookByAssetId.delete(assetId);
        }
      });
    }

    // Add assets to our subscription set
    assetIds.forEach(id => this.allSubscribedAssets.add(id));

    // If already connected, re-subscribe with all assets
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.subscribeToAll();
      return;
    }

    // If not connected, establish connection
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
      this.establishConnection();
    }
  }

  /**
   * Establish WebSocket connection
   */
  private establishConnection(): void {
    try {
      this.ws = new WebSocket(this.wsUrl);

      this.ws.on('open', () => {
        console.log('✅ Polymarket WebSocket connected');
        this.reconnectAttempts = 0;

        // Subscribe to ALL assets in one message
        this.subscribeToAll();

        this.startPingInterval();
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        this.handleMessage(data);
      });

      this.ws.on('close', (code: number, reason: string) => {
        console.log(`⚠️ Polymarket WebSocket closed: ${code} - ${reason}`);
        this.handleClose();
      });

      this.ws.on('error', (error: Error) => {
        console.error('❌ Polymarket WebSocket error:', error);
      });

      this.ws.on('pong', () => {
        this.lastMessageTime = Date.now();
      });
    } catch (error) {
      console.error('Failed to create WebSocket connection:', error);
      this.handleClose();
    }
  }

  /**
   * Subscribe to ALL tracked assets in a single message
   * This is critical - Polymarket replaces subscriptions, doesn't add to them
   */
  private subscribeToAll(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error('Cannot subscribe: WebSocket not connected');
      return;
    }

    if (this.allSubscribedAssets.size === 0) {
      return;
    }

    const assetIds = Array.from(this.allSubscribedAssets);
    
    const subscriptionMessage = {
      assets_ids: assetIds,
      type: 'market'
    };

    console.log(`📡 Subscribing to ${assetIds.length} assets in total:`, assetIds.map(id => id.slice(0, 8) + '...'));
    this.ws.send(JSON.stringify(subscriptionMessage));
  }

  /**
   * Wait for orderbook data to arrive for specific asset IDs
   */
  public async waitForOrderbookData(assetId1: string, assetId2: string, timeoutMs: number = 30000): Promise<boolean> {
    // Check if data already exists
    if (this.latestBookByAssetId.has(assetId1) && this.latestBookByAssetId.has(assetId2)) {
      console.log(`✅ Orderbook data already available for assets`);
      return true;
    }

    console.log(`⏳ Waiting for orderbook data for assets: ${assetId1.slice(0, 8)}..., ${assetId2.slice(0, 8)}...`);

    // Create promises for both assets
    const promises: Promise<void>[] = [];

    for (const assetId of [assetId1, assetId2]) {
      if (!this.latestBookByAssetId.has(assetId)) {
        const promise = new Promise<void>((resolve, reject) => {
          // Store the promise resolvers
          if (!this.pendingDataPromises.has(assetId)) {
            this.pendingDataPromises.set(assetId, []);
          }
          this.pendingDataPromises.get(assetId)!.push({ resolve, reject });

          // Set timeout
          setTimeout(() => {
            reject(new Error(`Timeout waiting for orderbook data for asset ${assetId.slice(0, 8)}...`));
          }, timeoutMs);
        });
        promises.push(promise);
      }
    }

    try {
      await Promise.all(promises);
      console.log(`✅ Received orderbook data for both assets`);
      return true;
    } catch (error) {
      console.error(`❌ Failed to receive orderbook data:`, error);
      return false;
    }
  }

  /**
   * Unsubscribe from specific assets
   */
  public unsubscribe(assetIds: string[]): void {
    console.log('📡 Unsubscribing from assets:', assetIds.map(id => id.slice(0, 8) + '...'));

    // Remove from subscription set
    assetIds.forEach(id => this.allSubscribedAssets.delete(id));

    // Clean up data
    for (const id of assetIds) {
      this.latestBookByAssetId.delete(id);
      this.pendingDataPromises.delete(id);
    }

    // Re-subscribe to remaining assets
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.subscribeToAll();
    }
  }

  /**
   * Handle incoming WebSocket messages
   */
  private handleMessage(data: WebSocket.Data): void {
    this.lastMessageTime = Date.now();

    try {
      const text = data.toString();

      // Polymarket sometimes sends plain text errors
      if (!text.startsWith("{")) {
        return;
      }

      const message: PolymarketMessage = JSON.parse(text);

      switch (message.event_type) {
        case 'book':
          this.handleBookMessage(message);
          break;
        default:
          break;
      }
    } catch (error) {
      console.error('Error parsing WebSocket message:', error);
    }
  }

  /**
   * Handle order book updates
   */
  private handleBookMessage(message: BookMessage): void {
    // Extract best bid and ask
    const bestBid = message.bids[message.bids.length - 1]?.price || '0';
    const bestAsk = message.asks[message.asks.length - 1]?.price || '0';

    const assetId = message.asset_id;
    const isFirstData = !this.latestBookByAssetId.has(assetId);

    // Store by assetId
    this.latestBookByAssetId.set(assetId, {
      bestBid,
      bestAsk
    });

    // If this is the first data for this asset, resolve any pending promises
    if (isFirstData && this.pendingDataPromises.has(assetId)) {
      const promises = this.pendingDataPromises.get(assetId)!;
      console.log(`📊 First orderbook data received for asset ${assetId.slice(0, 8)}... (bid: ${bestBid}, ask: ${bestAsk})`);
      
      promises.forEach(({ resolve }) => resolve());
      this.pendingDataPromises.delete(assetId);
    }
  }

  /**
   * Start the ping interval to keep the connection alive
   */
  private startPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
    }

    this.pingInterval = setInterval(() => {
      const timeSinceLastMessage = Date.now() - this.lastMessageTime;

      if (timeSinceLastMessage > this.pingIntervalMs) {
        if (this.ws?.readyState === WebSocket.OPEN) {
          console.log('No data received recently, sending PING');
          this.ws.send('PING');
        }
      }
    }, this.pingIntervalMs);
  }

  /**
   * Handle WebSocket close event
   */
  private handleClose(): void {
    this.cleanup();

    // Reject all pending promises
    this.pendingDataPromises.forEach((promises, assetId) => {
      promises.forEach(({ reject }) => {
        reject(new Error(`WebSocket closed while waiting for data for asset ${assetId}`));
      });
    });
    this.pendingDataPromises.clear();

    // Attempt reconnection if we have subscribed assets
    if (this.allSubscribedAssets.size > 0 && this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      console.log(`Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);

      setTimeout(() => {
        this.establishConnection();
      }, this.reconnectDelay);
    } else if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('Max reconnection attempts reached');
    }
  }

  /**
   * Clean up WebSocket connection and intervals
   */
  private cleanup(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }
      this.ws = null;
    }
  }

  /**
   * Get the latest order book data for a specific assetId
   */
  public getLatestBookByAssetId(assetId: string): { bestBid: string, bestAsk: string } | undefined {
    return this.latestBookByAssetId.get(assetId);
  }

  /**
   * Check if WebSocket is connected
   */
  public isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Disconnect and clean up
   */
  public disconnect(): void {
    console.log('Disconnecting Polymarket WebSocket');
    this.allSubscribedAssets.clear();
    this.reconnectAttempts = this.maxReconnectAttempts;
    this.cleanup();
  }
}
