import winston from "winston";

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

const transports: winston.transport[] = [
  new winston.transports.Console({
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.json()
    ),
  })
];

const logger = winston.createLogger({
  level: "info",
  defaultMeta: { service: "crypto-monitor-bot" },
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    sanitizeError(),
    winston.format.json()
  ),
  transports,
});

export default logger;
