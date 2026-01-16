// ============================================================================
// UPDATED TYPES (src/types/index.ts)
// ============================================================================

export interface OHLCV {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface MarketData {
  symbol: string;
  price: number;
  hourOpen: number;
  priceChange1m: number;
  priceChange5m: number;
  priceChange15m: number;
  priceChange1h: number;
  volume24h: number;
  volatility: number;
  timestamp: number;
}

export interface PolymarketMarket {
  id: string;
  question: string;
  slug: string;
  clobTokenIds: string;
  active: boolean;
  endDate: string;
  eventStartTime: string;
}

export interface OrderBookData {
  assetId: string;
  bids: Array<{ price: number; size: number }>;
  asks: Array<{ price: number; size: number }>;
  bestBid: number;
  bestAsk: number;
  spread: number;
  mid: number;
}

export interface Position {
  id: string;
  coin: string;
  marketId: string;
  marketSlug: string;
  side: 'UP' | 'DOWN' | 'SKIP';
  entryPrice: number;
  shares: number;
  costBasis: number;
  entryTime: number;
  hourOpenPrice: number;
  marketEndTime: number;
  status: 'OPEN' | 'HEDGED' | 'CLOSED';
  hedgePrice?: number;
  hedgeTime?: number;
  exitPrice?: number;
  exitTime?: number;
  pnl?: number;
  assetIds: {
    up: string;
    down: string;
  };
  confidence: number;
  upBalance?: number;
  downBalance?: number;
}

export interface TradeSignal {
  coin: string;
  direction: 'UP' | 'DOWN' | 'SKIP';
  confidence: number;
  reasons: string[];
  marketData: MarketData;
}

export interface RebalanceDecision {
  shouldRebalance: boolean;
  action?: 'BUY_UP' | 'BUY_DOWN' | 'SELL_UP' | 'SELL_DOWN';
  shares?: number;
  targetPrice?: number;
  currentImbalance: number;
  reason: string;
}

export interface MarketSession {
  coin: string;
  market: PolymarketMarket;
  positionId?: string;
  startTime: number;
  endTime: number;
  active: boolean;
}
