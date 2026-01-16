// ============================================================================
// UPDATED CONFIG (src/config/index.ts)
// ============================================================================

import dotenv from 'dotenv';
dotenv.config();

export interface CoinConfig {
  symbol: string;           // 'BTC', 'ETH', etc.
  ccxtSymbol: string;       // 'BTC/USDT'
  polymarketSlug: string;   // 'bitcoin-up-or-down'
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
  };
  rebalancing: {
    checkIntervalSeconds: number;
    minImbalanceThreshold: number;
    maxPriceSlippagePct: number;
    aggressiveThresholdPct: number;
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
      enabled: true,
    },
    {
      symbol: 'ETH',
      ccxtSymbol: 'ETH/USDT',
      polymarketSlug: 'ethereum-up-or-down',
      enabled: true,
    },
    {
      symbol: 'SOL',
      ccxtSymbol: 'SOL/USDT',
      polymarketSlug: 'solana-up-or-down',
      enabled: true,
    },
    {
      symbol: 'XRP',
      ccxtSymbol: 'XRP/USDT',
      polymarketSlug: 'xrp-up-or-down',
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
    enableRateLimit: true,
    options: {
      defaultType: 'spot',
    },
  },
  trading: {
    maxPositionSizeUSDC: 100,
    minProfitThreshold: 5,
    stopLossThreshold: 15,
  },
  rebalancing: {
    checkIntervalSeconds: 10,
    minImbalanceThreshold: 10,
    maxPriceSlippagePct: 5,
    aggressiveThresholdPct: 50,
  },
  risk: {
    maxTotalExposure: 500,
    maxConcurrentPositions: 4,
    emergencyStopLoss: 25,
  },
};

// Validate required environment variables
const requiredEnvVars = [
  'POLYMARKET_API_KEY',
  'POLYMARKET_API_SECRET',
  'POLYMARKET_API_PASSPHRASE',
  'PRIVATE_KEY',
  'DATABASE_URL',
];

const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingVars.length > 0) {
  throw new Error(
    `Missing required environment variables: ${missingVars.join(', ')}\n` +
    'Please check your .env file.'
  );
}
