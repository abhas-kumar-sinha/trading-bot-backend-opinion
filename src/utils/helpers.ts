export function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function formatPrice(price: number, decimals: number = 3): string {
  return `$${price.toFixed(decimals)}`;
}

export function formatPercent(value: number, decimals: number = 2): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(decimals)}%`;
}

export function formatTimeRemaining(endTime: number): string {
  const remaining = endTime - Date.now();
  const minutes = Math.floor(remaining / (60 * 1000));
  const seconds = Math.floor((remaining % (60 * 1000)) / 1000);
  
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function retry<T>(
  fn: () => Promise<T>,
  maxAttempts: number = 3,
  delayMs: number = 1000
): Promise<T> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === maxAttempts - 1) throw error;
      
      const backoffDelay = delayMs * Math.pow(2, i);
      console.log(`Retry attempt ${i + 1}/${maxAttempts} after ${backoffDelay}ms`);
      await sleep(backoffDelay);
    }
  }
  throw new Error('Max retry attempts reached');
}

/**
 * Safely parse JSON with fallback
 */
export function safeJSONParse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
}

/**
 * Generate unique ID
 */
export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Round to specific decimals
 */
export function roundTo(value: number, decimals: number): number {
  const multiplier = Math.pow(10, decimals);
  return Math.round(value * multiplier) / multiplier;
}

/**
 * Clamp value between min and max
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Calculate percentage change
 */
export function percentChange(oldValue: number, newValue: number): number {
  if (oldValue === 0) return 0;
  return ((newValue - oldValue) / oldValue) * 100;
}

/**
 * Check if market is currently active (1-hour window)
 */
export function isMarketActive(endTime: number): boolean {
  const now = Date.now();
  const timeRemaining = endTime - now;
  return timeRemaining > 0 && timeRemaining <= 60 * 60 * 1000; // Within 1 hour
}

/**
 * Get time until next hour
 */
export function msUntilNextHour(): number {
  const now = new Date();
  const nextHour = new Date(now);
  nextHour.setHours(now.getHours() + 1, 0, 0, 0);
  return nextHour.getTime() - now.getTime();
}

/**
 * Get current hour in ET timezone
 */
export function getCurrentHourET(): number {
  const now = new Date();
  const etTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return etTime.getHours();
}

/**
 * Format slug for Polymarket market
 */
export function generateMarketSlug(
  prefix: string,
  date: Date = new Date()
): string {
  const month = date.toLocaleString('en-US', { 
    month: 'long', 
    timeZone: 'America/New_York' 
  }).toLowerCase();
  const day = date.getDate();
  const hour = date.getHours();
  const ampm = hour >= 12 ? 'pm' : 'am';
  const hour12 = hour % 12 || 12;

  return `${prefix}-${month}-${day}-${hour12}${ampm}-et`;
}

/**
 * Validate environment variables
 */
export function validateEnv(requiredVars: string[]): void {
  const missing = requiredVars.filter(varName => !process.env[varName]);
  
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}\n` +
      'Please check your .env file.'
    );
  }
}

/**
 * Safe division (handles divide by zero)
 */
export function safeDivide(numerator: number, denominator: number, fallback: number = 0): number {
  return denominator === 0 ? fallback : numerator / denominator;
}

/**
 * Calculate position P&L
 */
export function calculatePnL(
  side: 'UP' | 'DOWN',
  entryPrice: number,
  currentPrice: number,
  hourOpen: number,
  shares: number
): number {
  const isWinning = (side === 'UP' && currentPrice > hourOpen) ||
                    (side === 'DOWN' && currentPrice < hourOpen);
  
  if (isWinning) {
    // Winning: would get $1 per share minus entry cost
    return (1 - entryPrice) * shares;
  } else {
    // Losing: would get $0 per share, lose entry cost
    return -entryPrice * shares;
  }
}

/**
 * Calculate ROI percentage
 */
export function calculateROI(profit: number, cost: number): number {
  return (profit / cost) * 100;
}

/**
 * Format table output for console
 */
export function formatTable(data: any[], headers: string[]): string {
  const rows = [headers, ...data];
  const colWidths = headers.map((_, i) => 
    Math.max(...rows.map(row => String(row[i] || '').length))
  );

  return rows
    .map(row => 
      row.map((cell: any, i: number) => 
        String(cell || '').padEnd(colWidths[i])
      ).join(' | ')
    )
    .join('\n');
}

/**
 * Create stats summary
 */
export interface BotStats {
  totalTrades: number;
  openPositions: number;
  closedPositions: number;
  hedgedPositions: number;
  totalPnL: number;
  winRate: number;
  avgProfit: number;
  avgLoss: number;
}

export function createStatsSummary(positions: any[]): BotStats {
  const closed = positions.filter(p => p.pnl !== undefined);
  const wins = closed.filter(p => p.pnl > 0);
  const losses = closed.filter(p => p.pnl < 0);

  return {
    totalTrades: positions.length,
    openPositions: positions.filter(p => p.status === 'OPEN').length,
    closedPositions: positions.filter(p => p.status === 'CLOSED').length,
    hedgedPositions: positions.filter(p => p.status === 'HEDGED').length,
    totalPnL: closed.reduce((sum, p) => sum + p.pnl, 0),
    winRate: safeDivide(wins.length, closed.length) * 100,
    avgProfit: safeDivide(
      wins.reduce((sum, p) => sum + p.pnl, 0),
      wins.length
    ),
    avgLoss: safeDivide(
      losses.reduce((sum, p) => sum + p.pnl, 0),
      losses.length
    ),
  };
}

/**
 * Print stats table
 */
export function printStats(stats: BotStats): void {
  console.log('\n' + '='.repeat(60));
  console.log('📊 BOT STATISTICS');
  console.log('='.repeat(60));
  console.log(`Total Trades:      ${stats.totalTrades}`);
  console.log(`Open Positions:    ${stats.openPositions}`);
  console.log(`Closed Positions:  ${stats.closedPositions}`);
  console.log(`Hedged Positions:  ${stats.hedgedPositions}`);
  console.log(`Total P&L:         ${formatPrice(stats.totalPnL, 2)}`);
  console.log(`Win Rate:          ${stats.winRate.toFixed(1)}%`);
  console.log(`Avg Profit:        ${formatPrice(stats.avgProfit, 2)}`);
  console.log(`Avg Loss:          ${formatPrice(stats.avgLoss, 2)}`);
  console.log('='.repeat(60) + '\n');
}

export default {
  formatTimestamp,
  formatPrice,
  formatPercent,
  formatTimeRemaining,
  sleep,
  retry,
  safeJSONParse,
  generateId,
  roundTo,
  clamp,
  percentChange,
  isMarketActive,
  msUntilNextHour,
  getCurrentHourET,
  generateMarketSlug,
  validateEnv,
  safeDivide,
  calculatePnL,
  calculateROI,
  formatTable,
  createStatsSummary,
  printStats,
};