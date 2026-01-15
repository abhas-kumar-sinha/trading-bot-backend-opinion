// ============================================================================
// 5. ADVANCED PREDICTION ENGINE (src/strategy/PredictionEngine.ts)
// ============================================================================

import { MarketData, TradeSignal } from "../types";

export class PredictionEngine {
  predict(data: MarketData): TradeSignal {
    const reasons: string[] = [];
    let confidence = 50;
    let direction: 'UP' | 'DOWN' | 'SKIP' = 'SKIP';

    const { priceChange1m, priceChange5m, priceChange15m, priceChange1h, volatility } = data;

    // Rule 1: Strong short-term momentum
    if (Math.abs(priceChange5m) > 0.3 && Math.abs(priceChange15m) > 0.5) {
      if (priceChange5m > 0 && priceChange15m > 0) {
        direction = 'UP';
        confidence += 20;
        reasons.push(`Strong upward momentum (5m: ${priceChange5m.toFixed(2)}%, 15m: ${priceChange15m.toFixed(2)}%)`);
      } else if (priceChange5m < 0 && priceChange15m < 0) {
        direction = 'DOWN';
        confidence += 20;
        reasons.push(`Strong downward momentum`);
      }
    }

    // Rule 2: Trend continuation
    if (Math.abs(priceChange1h) > 0.8) {
      if (priceChange5m > 0.1 && priceChange1h > 0) {
        direction = direction === 'UP' ? 'UP' : (direction === 'SKIP' ? 'UP' : 'SKIP');
        confidence += 15;
        reasons.push('Trend continuation (hourly uptrend)');
      } else if (priceChange5m < -0.1 && priceChange1h < 0) {
        direction = direction === 'DOWN' ? 'DOWN' : (direction === 'SKIP' ? 'DOWN' : 'SKIP');
        confidence += 15;
        reasons.push('Trend continuation (hourly downtrend)');
      }
    }

    // Rule 3: Mean reversion from extremes
    if (Math.abs(priceChange1h) > 1.5 && volatility > 2) {
      if (priceChange1h < -1.5 && priceChange5m > 0.2) {
        direction = 'UP';
        confidence += 10;
        reasons.push('Mean reversion bounce');
      } else if (priceChange1h > 1.5 && priceChange5m < -0.2) {
        direction = 'DOWN';
        confidence += 10;
        reasons.push('Mean reversion reversal');
      }
    }

    // Rule 4: Acceleration signal
    if (Math.abs(priceChange1m) > Math.abs(priceChange5m) * 1.5) {
      if (priceChange1m > 0) {
        direction = direction === 'UP' ? 'UP' : (direction === 'SKIP' ? 'UP' : 'SKIP');
        confidence += 5;
        reasons.push('Accelerating upward');
      } else {
        direction = direction === 'DOWN' ? 'DOWN' : (direction === 'SKIP' ? 'DOWN' : 'SKIP');
        confidence += 5;
        reasons.push('Accelerating downward');
      }
    }

    // Adjust confidence based on volatility
    if (volatility < 1) {
      confidence -= 10;
      reasons.push('Low volatility reduces confidence');
    } else if (volatility > 3) {
      confidence += 5;
      reasons.push('High volatility supports signal');
    }

    return {
      coin: data.symbol,
      direction,
      confidence: Math.min(Math.max(confidence, 0), 100),
      reasons,
      marketData: data,
    };
  }
}
