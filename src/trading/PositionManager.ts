// ============================================================================
// 6. POSITION & RISK MANAGER (src/trading/PositionManager.ts)
// ============================================================================

import { BotConfig } from "../config";
import { Position } from "../types";

export class PositionManager {
  private positions: Map<string, Position> = new Map();
  private config: BotConfig;

  constructor(config: BotConfig) {
    this.config = config;
  }

  openPosition(position: Position): void {
    this.positions.set(position.id, position);
    console.log(`\n✅ POSITION OPENED: ${position.coin} ${position.side}`);
    console.log(`   Entry: $${position.entryPrice.toFixed(4)} x ${position.shares} = $${position.costBasis.toFixed(2)}`);
    console.log(`   Confidence: ${position.confidence}%`);
  }

  updatePosition(id: string, updates: Partial<Position>): void {
    const pos = this.positions.get(id);
    if (pos) Object.assign(pos, updates);
  }

  closePosition(id: string, exitPrice: number, pnl: number): void {
    const pos = this.positions.get(id);
    if (pos) {
      pos.status = 'CLOSED';
      pos.exitPrice = exitPrice;
      pos.exitTime = Date.now();
      pos.pnl = pnl;
      console.log(`\n💰 CLOSED: ${pos.coin} ${pos.side} | P&L: $${pnl.toFixed(2)}`);
    }
  }

  getOpenPositions(): Position[] {
    return Array.from(this.positions.values()).filter(p => p.status === 'OPEN');
  }

  getTotalExposure(): number {
    return this.getOpenPositions().reduce((sum, p) => sum + p.costBasis, 0);
  }

  canOpenNewPosition(): boolean {
    const openCount = this.getOpenPositions().length;
    const totalExposure = this.getTotalExposure();

    return openCount < this.config.risk.maxConcurrentPositions &&
           totalExposure < this.config.risk.maxTotalExposure;
  }

  calculatePositionSize(confidence: number): number {
    const base = this.config.trading.maxPositionSizeUSDC;
    const thresholds = this.config.trading.confidenceThresholds;

    if (confidence >= thresholds.high) return base * 1.0;
    if (confidence >= thresholds.medium) return base * 0.7;
    return base * 0.5;
  }

  evaluatePosition(position: Position, currentPrice: number, upPrice: number, downPrice: number): 'HEDGE' | 'STOP_LOSS' | 'HOLD' {
    const priceMove = ((currentPrice - position.hourOpenPrice) / position.hourOpenPrice) * 100;
    const isWinning = (position.side === 'UP' && currentPrice > position.hourOpenPrice) ||
                      (position.side === 'DOWN' && currentPrice < position.hourOpenPrice);

    const timeRemaining = position.marketEndTime - Date.now();
    const minutesLeft = timeRemaining / 60000;

    // Emergency stop loss
    if (!isWinning && Math.abs(priceMove) > this.config.risk.emergencyStopLoss) {
      return 'STOP_LOSS';
    }

    // Hedge when profitable
    if (isWinning && Math.abs(priceMove) >= this.config.trading.hedgeThreshold) {
      const hedgeProfit = this.calculateHedgeProfit(position, upPrice, downPrice);
      if (hedgeProfit > position.shares * 0.05) {
        return 'HEDGE';
      }
    }

    // Stop loss near end if losing badly
    if (!isWinning && minutesLeft < 15 && Math.abs(priceMove) > this.config.trading.stopLossThreshold) {
      return 'STOP_LOSS';
    }

    return 'HOLD';
  }

  calculateHedgeProfit(position: Position, upPrice: number, downPrice: number): number {
    const hedgePrice = position.side === 'UP' ? downPrice : upPrice;
    const totalCost = position.entryPrice + hedgePrice;
    return (1.0 - totalCost) * position.shares;
  }

  getStats() {
    const all = Array.from(this.positions.values());
    const closed = all.filter(p => p.status === 'CLOSED');
    
    return {
      total: all.length,
      open: this.getOpenPositions().length,
      closed: closed.length,
      totalPnL: closed.reduce((sum, p) => sum + (p.pnl || 0), 0),
      totalExposure: this.getTotalExposure(),
    };
  }
}
