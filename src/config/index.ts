// ============================================================================
// 1. CONFIG (src/config/index.ts)
// ============================================================================

import dotenv from 'dotenv';
dotenv.config();

export interface CoinConfig {
  symbol: string;           // 'BTC', 'ETH', etc.
  ccxtSymbol: string;       // 'BTC/USDT'
  polymarketSlug: string;   // 'bitcoin-up-or-down'
  minConfidence: number;    // Minimum confidence to trade
  enabled: boolean;
}

export interface BotConfig {
  coins: CoinConfig[];
  polymarket: {
    apiKey: string;
    apiSecret: string;
    apiPassphrase: string;
    host: string;
    chainId: number;
    privateKey: string;
    gammaApiUrl: string;
    wsUrl: string;
  };
  ccxt: {
    exchange: string;
    enableRateLimit: boolean;
    options: {
      defaultType: string;
    };
  };
  trading: {
    maxPositionSizeUSDC: number;
    minProfitThreshold: number;
    stopLossThreshold: number;
    hedgeThreshold: number;
    confidenceThresholds: {
      high: number;
      medium: number;
      low: number;
    };
  };
  strategy: {
    predictionLeadMinutes: number;
    monitorIntervalSeconds: number;
    klineIntervals: string[];
  };
  risk: {
    maxTotalExposure: number;
    maxConcurrentPositions: number;
    emergencyStopLoss: number;
  };
}

export const config: BotConfig = {
  coins: [
    {
      symbol: 'BTC',
      ccxtSymbol: 'BTC/USDT',
      polymarketSlug: 'bitcoin-up-or-down',
      minConfidence: 55,
      enabled: true,
    },
    {
      symbol: 'ETH',
      ccxtSymbol: 'ETH/USDT',
      polymarketSlug: 'ethereum-up-or-down',
      minConfidence: 55,
      enabled: true,
    },
    {
      symbol: 'SOL',
      ccxtSymbol: 'SOL/USDT',
      polymarketSlug: 'solana-up-or-down',
      minConfidence: 55,
      enabled: true,
    },
    {
      symbol: 'XRP',
      ccxtSymbol: 'XRP/USDT',
      polymarketSlug: 'xrp-up-or-down',
      minConfidence: 55,
      enabled: true,
    },
  ],
  polymarket: {
    apiKey: process.env.POLYMARKET_API_KEY!,
    apiSecret: process.env.POLYMARKET_API_SECRET!,
    apiPassphrase: process.env.POLYMARKET_API_PASSPHRASE!,
    host: process.env.POLYMARKET_CLOB_HOST || 'https://clob.polymarket.com',
    chainId: 137, // Polygon
    privateKey: process.env.PRIVATE_KEY!,
    gammaApiUrl: process.env.POLYMARKET_GAMMA_API || 'https://gamma-api.polymarket.com',
    wsUrl: process.env.POLYMARKET_WSS_URL || 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
  },
  ccxt: {
    exchange: 'binance',
    enableRateLimit: false,
    options: {
      defaultType: 'spot',
    },
  },
  trading: {
    maxPositionSizeUSDC: 100,
    minProfitThreshold: 5,
    stopLossThreshold: 15,
    hedgeThreshold: 8,
    confidenceThresholds: {
      high: 70,
      medium: 60,
      low: 50,
    },
  },
  strategy: {
    predictionLeadMinutes: 5,
    monitorIntervalSeconds: 10,
    klineIntervals: ['1m', '5m', '15m', '1h'],
  },
  risk: {
    maxTotalExposure: 500,
    maxConcurrentPositions: 4,
    emergencyStopLoss: 25,
  },
};
