import dotenv from 'dotenv';

dotenv.config();

export const config = {
  server: {
    port: parseInt(process.env.PORT || '3000'),
    host: '0.0.0.0',
  },
  
  database: {
    url: process.env.NEON_DB_URL!,
  },

  polymarket: {
    key: process.env.POLYMARKET_API_KEY!,
    secret: process.env.POLYMARKET_API_SECRET!,
    passphrase: process.env.POLYMARKET_API_PASSPHRASE!,
    host: process.env.POLYMARKET_HOST!,
    gammaHost: process.env.POLYMARKET_GAMMA_API_HOST!,
    signer: process.env.PRIVATE_KEY!,
    wssUrl: process.env.POLYMARKET_CLOB_WSS_HOST!,
  },

  wallet: {
    wallet1: "0x63ce342161250d705dc0b16df89036c8e5f9ba9a"
  },

  rpc: {
    ankrRpcUrl: process.env.ANKR_RPC_URL!,
  },

  binance: {
    spot_websocket_url: process.env.BINANCE_SPOT_WEBSOCKET_URL!,
  }

} as const;
