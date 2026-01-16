// ============================================================================
// REBALANCING STRATEGY ENGINE (src/strategy/RebalancingEngine.ts)
// ============================================================================

import { MarketData, OrderBookData, Position, RebalanceDecision } from '../types';
import { BotConfig } from '../config';

export class RebalancingEngine {
  private config: BotConfig;

  constructor(config: BotConfig) {
    this.config = config;
  }

  /**
   * Evaluate if rebalancing is needed based on current position and market conditions
   */
  evaluateRebalancing(
    position: Position,
    marketData: MarketData,
    upBook: OrderBookData,
    downBook: OrderBookData
  ): RebalanceDecision {
    const upBalance = position.upBalance || 0;
    const downBalance = position.downBalance || 0;
    const imbalance = Math.abs(upBalance - downBalance);

    // No rebalancing needed if perfectly balanced
    if (imbalance === 0) {
      return {
        shouldRebalance: false,
        currentImbalance: imbalance,
        reason: 'Positions already balanced',
      };
    }

    // Determine which side needs more shares
    const needsMoreUp = upBalance < downBalance;
    const needsMoreDown = downBalance < upBalance;

    // Check if we should buy based on price movement and orderbook
    if (needsMoreUp) {
      return this.evaluateUpPurchase(position, marketData, upBook, imbalance);
    } else if (needsMoreDown) {
      return this.evaluateDownPurchase(position, marketData, downBook, imbalance);
    }

    return {
      shouldRebalance: false,
      currentImbalance: imbalance,
      reason: 'No rebalancing needed',
    };
  }

  private evaluateUpPurchase(
    position: Position,
    marketData: MarketData,
    upBook: OrderBookData,
    imbalance: number
  ): RebalanceDecision {
    const currentPrice = marketData.price;
    const hourOpen = position.hourOpenPrice;
    const priceMovement = ((currentPrice - hourOpen) / hourOpen) * 100;

    // Calculate target price (look for good entry)
    const avgEntryPrice = position.costBasis / position.shares;
    const targetPrice = Math.max(avgEntryPrice - 0.03, upBook.bestAsk - 0.02);

    // Strategy: Buy UP tokens when:
    // 1. Price is moving down (discount on UP tokens)
    // 2. UP orderbook price is attractive
    // 3. We need to balance

    const isPriceDropping = priceMovement < -0.5 || marketData.priceChange5m < -0.3;
    const isGoodPrice = upBook.bestAsk <= targetPrice;
    const hasLiquidity = upBook.asks[0]?.size >= imbalance;

    if (isPriceDropping && isGoodPrice && hasLiquidity) {
      return {
        shouldRebalance: true,
        action: 'BUY_UP',
        shares: imbalance,
        targetPrice: upBook.bestAsk,
        currentImbalance: imbalance,
        reason: `Price dropping ${priceMovement.toFixed(2)}%, UP @ ${upBook.bestAsk.toFixed(4)} is attractive`,
      };
    }

    // Aggressive rebalancing if very imbalanced and price is reasonable
    if (imbalance > position.shares * 0.5 && upBook.bestAsk < 0.55) {
      return {
        shouldRebalance: true,
        action: 'BUY_UP',
        shares: imbalance,
        targetPrice: upBook.bestAsk,
        currentImbalance: imbalance,
        reason: `High imbalance (${imbalance}), reasonable price ${upBook.bestAsk.toFixed(4)}`,
      };
    }

    return {
      shouldRebalance: false,
      currentImbalance: imbalance,
      reason: `Waiting for better UP price (current: ${upBook.bestAsk.toFixed(4)}, target: ${targetPrice.toFixed(4)})`,
    };
  }

  private evaluateDownPurchase(
    position: Position,
    marketData: MarketData,
    downBook: OrderBookData,
    imbalance: number
  ): RebalanceDecision {
    const currentPrice = marketData.price;
    const hourOpen = position.hourOpenPrice;
    const priceMovement = ((currentPrice - hourOpen) / hourOpen) * 100;

    // Calculate target price
    const avgEntryPrice = position.costBasis / position.shares;
    const targetPrice = Math.max(avgEntryPrice - 0.03, downBook.bestAsk - 0.02);

    // Strategy: Buy DOWN tokens when:
    // 1. Price is moving up (discount on DOWN tokens)
    // 2. DOWN orderbook price is attractive
    // 3. We need to balance

    const isPriceRising = priceMovement > 0.5 || marketData.priceChange5m > 0.3;
    const isGoodPrice = downBook.bestAsk <= targetPrice;
    const hasLiquidity = downBook.asks[0]?.size >= imbalance;

    if (isPriceRising && isGoodPrice && hasLiquidity) {
      return {
        shouldRebalance: true,
        action: 'BUY_DOWN',
        shares: imbalance,
        targetPrice: downBook.bestAsk,
        currentImbalance: imbalance,
        reason: `Price rising ${priceMovement.toFixed(2)}%, DOWN @ ${downBook.bestAsk.toFixed(4)} is attractive`,
      };
    }

    // Aggressive rebalancing if very imbalanced and price is reasonable
    if (imbalance > position.shares * 0.5 && downBook.bestAsk < 0.55) {
      return {
        shouldRebalance: true,
        action: 'BUY_DOWN',
        shares: imbalance,
        targetPrice: downBook.bestAsk,
        currentImbalance: imbalance,
        reason: `High imbalance (${imbalance}), reasonable price ${downBook.bestAsk.toFixed(4)}`,
      };
    }

    return {
      shouldRebalance: false,
      currentImbalance: imbalance,
      reason: `Waiting for better DOWN price (current: ${downBook.bestAsk.toFixed(4)}, target: ${targetPrice.toFixed(4)})`,
    };
  }

  /**
   * Calculate expected profit from a balanced position
   */
  calculateBalancedProfit(
    upShares: number,
    downShares: number,
    avgUpPrice: number,
    avgDownPrice: number
  ): number {
    const totalShares = Math.min(upShares, downShares);
    const totalCost = (avgUpPrice + avgDownPrice) * totalShares;
    const totalPayout = totalShares * 1.0; // $1 per matched pair
    
    return totalPayout - totalCost;
  }

  /**
   * Determine if position should be closed early
   */
  shouldCloseEarly(
    position: Position,
    marketData: MarketData,
    upBook: OrderBookData,
    downBook: OrderBookData,
    minutesRemaining: number
  ): boolean {
    const upBalance = position.upBalance || 0;
    const downBalance = position.downBalance || 0;
    const isBalanced = upBalance === downBalance;

    if (!isBalanced) return false;

    // Close if profit is locked and we're within 10 minutes
    if (minutesRemaining < 10) {
      const avgUpPrice = position.costBasis / (2 * upBalance); // Assuming equal splits
      const avgDownPrice = position.costBasis / (2 * downBalance);
      const profit = this.calculateBalancedProfit(upBalance, downBalance, avgUpPrice, avgDownPrice);
      
      if (profit > position.shares * 0.05) { // 5% profit threshold
        return true;
      }
    }

    return false;
  }

  /**
   * Calculate optimal rebalancing schedule
   */
  getRebalancingSchedule(position: Position, totalMinutes: number): number[] {
    // Create checkpoints throughout the hour
    const checkpoints: number[] = [];
    const startTime = position.entryTime;
    const interval = 10000; // 10 seconds

    for (let i = 0; i < totalMinutes * 6; i++) {
      checkpoints.push(startTime + (i * interval));
    }

    return checkpoints;
  }
}
