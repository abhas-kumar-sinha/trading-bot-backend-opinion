import WebSocket from 'ws';
import axios from 'axios';
import { BookMessage, PriceChange, PriceChangeMessage } from './types';
import { config } from '../config';

type PolymarketMessage = BookMessage | PriceChangeMessage;

export class PolymarketWebSocket {
    private ws: WebSocket | null = null;
    private readonly wsUrl = config.polymarket.wsUrl;
    private subscribedAssets: Set<string> = new Set();
    private reconnectAttempts = 0;
    private readonly maxReconnectAttempts = 5;
    private readonly reconnectDelay = 5000; // 5 seconds
    private pingInterval: NodeJS.Timeout | null = null;
    private readonly pingIntervalMs = 30000; // 30 seconds
    private lastMessageTime = Date.now();
    private isConnecting = false;

    // Store latest data - keyed by assetId
    private latestBookByAssetId: Map<string, { bestBid: string, bestAsk: string }> = new Map();
    private latestPriceChanges: PriceChange[] = [];

    /**
     * Connect to the WebSocket
     */
    public connect(assetId1: string, assetId2: string): void {
        // Add new assets to subscription list
        this.subscribedAssets.add(assetId1);
        this.subscribedAssets.add(assetId2);

        // If already connected, just subscribe to new assets
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.subscribe([assetId1, assetId2]);
            return;
        }

        // If connection is in progress, wait for it to complete
        if (this.isConnecting) {
            console.log('Connection already in progress, assets will be subscribed when ready');
            return;
        }

        // If not connected, establish connection
        if (!this.ws) {
            this.establishConnection();
        }

    }

    /**
     * Establish WebSocket connection
     */
    private establishConnection(): void {
        if (this.isConnecting) {
            return;
        }

        this.isConnecting = true;

        try {
            this.ws = new WebSocket(this.wsUrl);

            this.ws.on('open', () => {
                console.log('✅ Polymarket WebSocket connected');
                this.isConnecting = false;
                this.reconnectAttempts = 0;

                // Subscribe to all assets in the set
                if (this.subscribedAssets.size > 0) {
                    this.subscribe(Array.from(this.subscribedAssets));
                }

                this.startPingInterval();
            });

            this.ws.on('message', (data: WebSocket.Data) => {
                this.handleMessage(data);
            });

            this.ws.on('close', (code: number, reason: string) => {
                console.log(`⚠️ Polymarket WebSocket closed: ${code} - ${reason}`);
                this.isConnecting = false;
                this.handleClose();
            });

            this.ws.on('error', (error: Error) => {
                console.error('❌ Polymarket WebSocket error:', error);
                this.isConnecting = false;
            });

            this.ws.on('pong', () => {
                this.lastMessageTime = Date.now();
            });
        } catch (error) {
            console.error('Failed to create WebSocket connection:', error);
            this.isConnecting = false;
            this.handleClose();
        }
    }

    /**
     * Subscribe to market data for specific assets
     */
    private subscribe(assetIds: string[]): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.error('Cannot subscribe: WebSocket not connected');
            return;
        }

        const subscriptionMessage = {
            assets_ids: assetIds,
            type: 'market'
        };

        console.log('📡 Subscribing to assets:', assetIds);
        this.ws.send(JSON.stringify(subscriptionMessage));
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
                case 'price_change':
                    this.handlePriceChangeMessage(message);
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

        // Store by assetId
        this.latestBookByAssetId.set(message.asset_id, {
            bestBid,
            bestAsk
        });
    }

    /**
     * Handle price change updates
     */
    private async handlePriceChangeMessage(message: PriceChangeMessage): Promise<void> {
        this.latestPriceChanges = message.price_changes;
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

        // Attempt reconnection if we have subscribed assets
        if (this.subscribedAssets.size > 0 && this.reconnectAttempts < this.maxReconnectAttempts) {
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
     * Get all latest order book data
     */
    public getAllLatestBooks(): Map<string, { bestBid: string, bestAsk: string }> {
        return this.latestBookByAssetId;
    }

    /**
     * Get the latest price changes
     */
    public getLatestPriceChanges(): PriceChange[] {
        return this.latestPriceChanges;
    }

    /**
     * Get all subscribed asset IDs
     */
    public getSubscribedAssets(): string[] {
        return Array.from(this.subscribedAssets);
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
        this.subscribedAssets.clear();
        this.reconnectAttempts = this.maxReconnectAttempts;
        this.cleanup();
    }
}
