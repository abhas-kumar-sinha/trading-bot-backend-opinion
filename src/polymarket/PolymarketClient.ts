import { Chain, ClobClient } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import { config } from "../config";
import axios from "axios";
import { DateTime } from "luxon";
import { BinanceWebSocket } from "../binance/websocket";
import { PolymarketWebSocket } from "./websocket";
import { Market } from "./types";

export class PolymarketClient {
    private client: ClobClient;
    private host: string;
    private gammaHost: string;
    private signer: Wallet;
    private signatureType: number;
    private updateInterval?: NodeJS.Timeout;
    private binanceWebSocket: BinanceWebSocket;
    private polymarketWebSocket: PolymarketWebSocket;

    public activeMarket1h: any = null;
    public priceToBeat: number | null = null;

    constructor(
        binanceWebSocket: BinanceWebSocket,
        host: string = config.polymarket.host,
        gammaHost: string = config.polymarket.gammaHost,
        privateKey: string = config.polymarket.signer,
        credentials: {
            key: string;
            secret: string;
            passphrase: string;
        } = {
                key: config.polymarket.key,
                secret: config.polymarket.secret,
                passphrase: config.polymarket.passphrase
            },
        signatureType: number = 0
    ) {
        this.binanceWebSocket = binanceWebSocket;
        this.host = host;
        this.gammaHost = gammaHost;
        this.signer = new Wallet(privateKey);
        this.signatureType = signatureType;

        this.client = new ClobClient(
            this.host,
            Chain.POLYGON,
            this.signer,
            credentials,
            this.signatureType
        );

        // Initialize Polymarket WebSocket
        this.polymarketWebSocket = new PolymarketWebSocket();

        // Start updating active market immediately
        this.updateActiveMarket();

        // Schedule updates at specific times (on the hour and half-hour)
        this.scheduleNextUpdate();
    }

    getClient(): ClobClient {
        return this.client;
    }

    getCurrentMarketId(): string {
        return this.activeMarket1h.id;
    }

    private async getMarketBySlug(slug: string): Promise<Market> {
        const market = await axios.get(`${this.gammaHost}/markets/slug/${slug}`);
        return market.data;
    }

    private scheduleNextUpdate(): void {
        // Calculate time until next half-hour mark (12:00, 12:30, 1:00, 1:30, etc.)
        const now = DateTime.now().setZone("America/New_York");
        const currentMinute = now.minute;
        const currentSecond = now.second;

        // Calculate minutes until next half-hour mark
        let minutesUntilNext: number;
        if (currentMinute < 30) {
            minutesUntilNext = 30 - currentMinute;
        } else {
            minutesUntilNext = 60 - currentMinute;
        }

        // Calculate total milliseconds until next update
        const msUntilNext = (minutesUntilNext * 60 - currentSecond) * 1000;

        console.log(`Next market update scheduled in ${minutesUntilNext} minutes and ${60 - currentSecond} seconds`);

        // Schedule the next update
        setTimeout(() => {
            this.updateActiveMarket();
            // After the first scheduled update, set up regular 30-minute intervals
            this.updateInterval = setInterval(() => this.updateActiveMarket(), 30 * 60 * 1000);
        }, msUntilNext);
    }

    private async updateActiveMarket(): Promise<void> {
        try {
            // Get current time in ET timezone
            const now = DateTime.now().setZone("America/New_York");

            // Generate the slug based on current time
            // Format: bitcoin-up-or-down-january-10-4pm-et
            const month = now.toFormat("LLLL").toLowerCase(); // Full month name
            const day = now.day; // Day of month
            const hour = now.hour;
            const ampm = hour >= 12 ? "pm" : "am";
            const hour12 = hour % 12 || 12; // Convert to 12-hour format

            const slug = `bitcoin-up-or-down-${month}-${day}-${hour12}${ampm}-et`;

            console.log(`Updating active market with slug: ${slug}`);

            // Fetch the market using the generated slug
            const response = await this.getMarketBySlug(slug);
            this.activeMarket1h = response;

            console.log(`Active market updated successfully:`, this.activeMarket1h);

            // Update Polymarket WebSocket subscription with the new market's first clobTokenId
            if (this.activeMarket1h.clobTokenIds && this.activeMarket1h.clobTokenIds.length > 0) {
                const assetId = JSON.parse(this.activeMarket1h.clobTokenIds);
                console.log(`Connecting Polymarket WebSocket to asset: ${assetId}`);
                this.polymarketWebSocket.connect(assetId[0], assetId[1]);
            } else {
                console.warn('No clobTokenIds found in active market');
            }

            // Get the hour's open price from Binance WebSocket
            // For 1h klines, all klines in the current hour have the same open value
            const latestKline = this.binanceWebSocket.getLatest1HKline();

            if (latestKline) {
                this.priceToBeat = parseFloat(latestKline.o);
                console.log(`Price to beat set to: ${this.priceToBeat} (current hour's open price)`);
            } else {
                // Fallback: use the last hour's last kline close price
                const klines1h = this.binanceWebSocket.get1HKlines();
                if (klines1h.length > 0) {
                    const lastKline = klines1h[klines1h.length - 1];
                    this.priceToBeat = parseFloat(lastKline.c);
                    console.log(`Price to beat set to: ${this.priceToBeat} (fallback to last hour's close price)`);
                } else {
                    console.warn('No 1h kline data available yet from Binance WebSocket');
                    this.priceToBeat = null;
                }
            }
        } catch (error) {
            console.error(`Failed to update active market:`, error);
        }
    }

    public stopUpdates(): void {
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
            this.updateInterval = undefined;
        }

        // Disconnect Polymarket WebSocket
        this.polymarketWebSocket.disconnect();
    }

    public getPolymarketWebSocket(): PolymarketWebSocket {
        return this.polymarketWebSocket;
    }
}
