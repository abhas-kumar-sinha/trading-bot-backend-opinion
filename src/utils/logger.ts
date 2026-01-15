import winston from 'winston';

const sanitizeError = winston.format((info) => {
  const anyInfo = info as any;
  let err: any = null;

  if (anyInfo instanceof Error) {
    err = anyInfo;
  } else if (anyInfo.error instanceof Error || (anyInfo.error && anyInfo.error.isAxiosError)) {
    err = anyInfo.error;
  }

  if (!err) return info;

  if (err.isAxiosError) {
    anyInfo.error = {
      name: err.name,
      message: err.message,
      status: err.response?.status,
      data: err.response?.data,
      url: err.config?.url,
      method: err.config?.method,
    };
  } else {
    anyInfo.error = {
      name: err.name,
      message: err.message,
      stack: err.stack,
    };
  }

  delete anyInfo.response;
  delete anyInfo.request;
  delete anyInfo.config;

  return info;
});

// Custom format for console output with colors
const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    let msg = `${timestamp} [${level}]: ${message}`;
    if (Object.keys(meta).length > 0) {
      msg += `
${JSON.stringify(meta, null, 2)}`;
    }
    return msg;
  })
);

// File format without colors
const fileFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  sanitizeError(),
  winston.format.json()
);

const transports: winston.transport[] = [
  // Console transport (always enabled)
  new winston.transports.Console({
    format: consoleFormat,
  }),
  
  // File transports (for production)
  new winston.transports.File({
    filename: 'logs/error.log',
    level: 'error',
    format: fileFormat,
  }),
  new winston.transports.File({
    filename: 'logs/combined.log',
    format: fileFormat,
  }),
];

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  defaultMeta: { service: 'polymarket-bot' },
  transports,
});

// Helper methods
export const log = {
  info: (message: string, meta?: any) => logger.info(message, meta),
  warn: (message: string, meta?: any) => logger.warn(message, meta),
  error: (message: string, meta?: any) => logger.error(message, meta),
  debug: (message: string, meta?: any) => logger.debug(message, meta),
  
  // Specific bot events
  prediction: (coin: string, side: string, confidence: number) => {
    logger.info(`Prediction: ${coin} ${side}`, { coin, side, confidence });
  },
  
  entry: (coin: string, side: string, price: number, shares: number) => {
    logger.info(`Entry: ${coin} ${side} @ $${price} x ${shares}`, {
      coin, side, price, shares, totalCost: price * shares,
    });
  },
  
  hedge: (coin: string, profit: number) => {
    logger.info(`Hedge: ${coin} locked $${profit.toFixed(2)} profit`, {
      coin, profit,
    });
  },
  
  stopLoss: (coin: string, loss: number) => {
    logger.warn(`Stop-Loss: ${coin} cut $${Math.abs(loss).toFixed(2)} loss`, {
      coin, loss,
    });
  },
  
  position: (position: any) => {
    logger.info('Position Update', position);
  },
};

export default logger;
