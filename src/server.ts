// src/server.ts
import express from 'express';
import cors from 'cors';
import logger from './utils/logger';
import { config } from './config';
import { PolymarketClient } from './polymarket/PolymarketClient';
import { BinanceWebSocket } from './binance/websocket';

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.get('/', (req, res) => {
  res.json({status: 'ok', timestamp: Date.now()});
});

app.get('/api/health', (req, res) => {
  res.json({
    uptime: process.uptime(),
    timestamp: Date.now(),
    status: 'ok'
  });
});

// Error handling
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

app.use(/.*/, (req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found'
  });
});

// Start server
async function startServer() {
  try {

    const server = app.listen(config.server.port, config.server.host, async () => {
      logger.info(`🌟 Crypto Monitoring Bot API running on port ${config.server.port}`);

      const binanceWebSocket = new BinanceWebSocket();

      await new Promise(resolve => setTimeout(resolve, 5000));

      const polymarketClient = new PolymarketClient(binanceWebSocket);
      const client = polymarketClient.getClient();

    });

    // Graceful shutdown
    const shutdown = () => {
      logger.info('Shutdown signal received, shutting down gracefully');
      server.close(() => {
        logger.info('Process terminated');
        process.exit(0);
      });
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();

export default app;
