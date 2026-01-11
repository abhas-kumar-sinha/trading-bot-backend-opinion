import WebSocket from 'ws';
import { config } from '../config';

interface KlineData {
    t: number;       // Kline start time
    T: number;       // Kline close time
    s: string;       // Symbol
    i: string;       // Interval
    f: number;       // First trade ID
    L: number;       // Last trade ID
    o: string;       // Open price
    c: string;       // Close price
    h: string;       // High price
    l: string;       // Low price
    v: string;       // Base asset volume
    n: number;       // Number of trades
    x: boolean;      // Is this kline closed?
    q: string;       // Quote asset volume
    V: string;       // Taker buy base asset volume
    Q: string;       // Taker buy quote asset volume
    B: string;       // Ignore
}

interface KlineMessage {
    e: string;       // Event type
    E: number;       // Event time
    s: string;       // Symbol
    k: KlineData;
}

interface AggTradeData {
    e: string;       // Event type
    E: number;       // Event time
    s: string;       // Symbol
    a: number;       // Aggregate trade ID
    p: string;       // Price
    q: string;       // Quantity
    f: number;       // First trade ID
    l: number;       // Last trade ID
    T: number;       // Trade time
    m: boolean;      // Is the buyer the market maker?
    M: boolean;      // Ignore
}

interface DepthData {
    e: string;       // Event type
    E: number;       // Event time
    s: string;       // Symbol
    U: number;       // First update ID in event
    u: number;       // Final update ID in event
    b: [string, string][]; // Bids to be updated
    a: [string, string][]; // Asks to be updated
}

export class BinanceWebSocket {
    private ws: WebSocket | null = null;
    private readonly baseUrl = config.binance.spot_websocket_url;
    private reconnectAttempts = 0;
    private readonly maxReconnectAttempts = 10;
    private reconnectTimeout: NodeJS.Timeout | null = null;

    // Separate storage for different data types
    private BTCUSDT_1min: KlineData[] = [];
    private BTCUSDT_1h: KlineData[] = [];
    private aggTrades: Map<string, AggTradeData> = new Map(); // symbol -> latest aggTrade
    private depth: Map<string, DepthData> = new Map(); // symbol -> latest depth

    private readonly MAX_1MIN_HISTORY = 15; // Store last 15 minutes of 1min klines
    private readonly MAX_1H_HISTORY = 5; // Store last 5 hours of 1h klines

    private subscriptions = [
        'btcusdt@aggTrade',
        'btcusdt@depth',
        'btcusdt@kline_1m',
        'btcusdt@kline_1h'
    ];

    constructor() {
        this.connect();
    }

    private connect(): void {
        console.log('Connecting to Binance WebSocket...');
        this.ws = new WebSocket(this.baseUrl);

        this.ws.on('open', () => {
            console.log('WebSocket connected');
            this.reconnectAttempts = 0;
            this.subscribe();
        });

        this.ws.on('message', (data: WebSocket.Data) => {
            try {
                const message = JSON.parse(data.toString());
                this.handleMessage(message);
            } catch (error) {
                console.error('Error parsing message:', error);
            }
        });

        this.ws.on('error', (error: Error) => {
            console.error('WebSocket error:', error);
        });

        this.ws.on('close', () => {
            console.log('WebSocket closed');
            this.reconnect();
        });
    }

    private subscribe(): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.error('WebSocket is not open, cannot subscribe');
            return;
        }

        const subscribeMessage = {
            method: 'SUBSCRIBE',
            params: this.subscriptions,
            id: 1
        };

        this.ws.send(JSON.stringify(subscribeMessage));
        console.log('Subscription request sent:', subscribeMessage);
    }

    private handleMessage(message: any): void {
        // Handle subscription confirmation
        if (message.result === null && message.id === 1) {
            console.log('Subscription confirmed:', message);
            return;
        }

        // Handle stream data
        if (message.stream && message.data) {
            const { stream, data } = message;

            if (stream.includes('@kline_1m')) {
                this.handleKline1m(data);
            } else if (stream.includes('@kline_1h')) {
                this.handleKline1h(data);
            } else if (stream.includes('@aggTrade')) {
                this.handleAggTrade(data);
            } else if (stream.includes('@depth')) {
                this.handleDepth(data);
            }
        }
    }

    private handleKline1m(data: KlineMessage): void {
        const kline = data.k;

        // Only store closed klines
        if (kline.x) {
            this.BTCUSDT_1min.push(kline);

            // Keep only the last 15 minutes
            if (this.BTCUSDT_1min.length > this.MAX_1MIN_HISTORY) {
                this.BTCUSDT_1min.shift();
            }
        }
    }

    private handleKline1h(data: KlineMessage): void {
        const kline = data.k;

        this.BTCUSDT_1h.push(kline);

        // Keep only the last 5 hours
        if (this.BTCUSDT_1h.length > this.MAX_1H_HISTORY) {
            this.BTCUSDT_1h.shift();
        }

    }

    private handleAggTrade(data: AggTradeData): void {
        this.aggTrades.set(data.s, data);
    }

    private handleDepth(data: DepthData): void {
        this.depth.set(data.s, data);
    }

    private reconnect(): void {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error('Max reconnection attempts reached');
            return;
        }

        this.reconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);

        console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

        this.reconnectTimeout = setTimeout(() => {
            this.connect();
        }, delay);
    }

    // Public getters
    public get1MinKlines(): KlineData[] {
        return [...this.BTCUSDT_1min];
    }

    public get1HKlines(): KlineData[] {
        return [...this.BTCUSDT_1h];
    }

    public getAggTrade(symbol: string): AggTradeData | undefined {
        return this.aggTrades.get(symbol);
    }

    public getDepth(symbol: string): DepthData | undefined {
        return this.depth.get(symbol);
    }

    public getLatest1MinKline(): KlineData | undefined {
        return this.BTCUSDT_1min[this.BTCUSDT_1min.length - 1];
    }

    public getLatest1HKline(): KlineData | undefined {
        return this.BTCUSDT_1h[this.BTCUSDT_1h.length - 1];
    }

    // Cleanup
    public disconnect(): void {
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
        }

        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }

        console.log('WebSocket disconnected');
    }
}

