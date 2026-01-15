import WebSocket from 'ws';
import axios from 'axios';
import { BookMessage, PriceChange, PriceChangeMessage } from './types';
import { config } from '../config';

type PolymarketMessage = BookMessage | PriceChangeMessage;

export class PolymarketWebSocket {
    private ws: WebSocket | null = null;
    private readonly wsUrl = config.polymarket.wssUrl;
    private currentAssetId1: string | null = null;
    private currentAssetId2: string | null = null;
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
     * Connect to the WebSocket and subscribe to a market
     */
    public connect(assetId1: string, assetId2: string): void {
        if (this.isConnecting) {
            console.log('Connection already in progress, waiting...');
            return;
        }

        if (this.currentAssetId1 === assetId1 && this.ws?.readyState === WebSocket.OPEN) {
            console.log(`Already connected to asset ${assetId1}`);
            return;
        }

        // If changing markets, close existing connection first
        if (this.ws) {
            this.cleanup();
        }

        this.currentAssetId1 = assetId1;
        this.currentAssetId2 = assetId2;
        this.isConnecting = true;

        try {
            this.ws = new WebSocket(this.wsUrl);

            this.ws.on('open', () => {
                console.log('Polymarket WebSocket connected');
                this.isConnecting = false;
                this.reconnectAttempts = 0;
                this.subscribe(assetId1, assetId2);
                this.startPingInterval();
            });

            this.ws.on('message', (data: WebSocket.Data) => {
                this.handleMessage(data);
            });

            this.ws.on('close', (code: number, reason: string) => {
                console.log(`Polymarket WebSocket closed: ${code} - ${reason}`);
                this.isConnecting = false;
                this.handleClose();
            });

            this.ws.on('error', (error: Error) => {
                console.error('Polymarket WebSocket error:', error);
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
     * Subscribe to market data for a specific asset
     */
    private subscribe(assetId1: string, assetId2: string): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.error('Cannot subscribe: WebSocket not connected');
            return;
        }

        const subscriptionMessage = {
            assets_ids: [assetId1, assetId2],
            type: 'market'
        };

        console.log('Sending subscription message:', subscriptionMessage);
        this.ws.send(JSON.stringify(subscriptionMessage));
    }

    /**
     * Handle incoming WebSocket messages
     */
    private handleMessage(data: WebSocket.Data): void {
        this.lastMessageTime = Date.now();

        try {
            const message: PolymarketMessage = JSON.parse(data.toString());

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

        // Attempt reconnection if we have a current asset ID
        if (this.currentAssetId1 && this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            console.log(`Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);

            setTimeout(() => {
                if (this.currentAssetId1) {
                    this.connect(this.currentAssetId1, this.currentAssetId2);
                }
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
     * Get the current asset ID
     */
    public getCurrentAssetIds(): string[] {
        return [this.currentAssetId1, this.currentAssetId2];
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
        this.currentAssetId1 = null;
        this.currentAssetId2 = null;
        this.reconnectAttempts = this.maxReconnectAttempts;
        this.cleanup();
    }
}
