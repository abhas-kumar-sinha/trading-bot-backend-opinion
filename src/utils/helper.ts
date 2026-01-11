export function formatedInterval(interval: string): string {
  switch (interval) {
    case '1m':
      return '1min';
    case '30m':
      return '30min';
    case '1h':
      return '1h';
    case '12h':
      return '12h';
    case '1d':
      return '1d';
    case '1w':
      return '1w';
    case '1M':
      return '1m';
    default:
      return '1min';
  }
}

export function generateTraceId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c == 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

export function calculateRiskScore(transaction: any): number {
  let score = 0;
  
  if (transaction.tokenRiskLevel > 2) score += 30;
  if (parseFloat(transaction.marketCap) < 100000) score += 20;
  if (transaction.launchTime && Date.now() - transaction.launchTime < 86400000) score += 25;
  if (parseFloat(transaction.txUsdValue) > 10000) score += 15;
  
  return Math.min(score, 100);
}

export function isHighValueTransaction(txUsdValue: string, threshold: number = 1000): boolean {
  return parseFloat(txUsdValue) >= threshold;
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
