// src/binance/types.ts
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

export { KlineData, KlineMessage, AggTradeData, DepthData };