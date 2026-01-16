// ============================================================================
// DATABASE CLIENT (src/database/client.ts)
// ============================================================================

import { Pool, PoolClient, QueryResult } from 'pg';
import { Position } from '../types';

export class DatabaseClient {
  private pool: Pool;
  private sessionId: string;

  constructor() {
    this.pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });

    this.sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    this.initializeSession();
  }

   private async ensureSchema(): Promise<void> {
   const schemaSQL = `
      -- Positions table
      CREATE TABLE IF NOT EXISTS positions (
      id VARCHAR(255) PRIMARY KEY,
      coin VARCHAR(10) NOT NULL,
      market_id VARCHAR(255) NOT NULL,
      market_slug VARCHAR(255) NOT NULL,
      side VARCHAR(10) NOT NULL,
      entry_price DECIMAL(10, 6) NOT NULL,
      shares INTEGER NOT NULL,
      cost_basis DECIMAL(12, 2) NOT NULL,
      entry_time BIGINT NOT NULL,
      hour_open_price DECIMAL(12, 2) NOT NULL,
      market_end_time BIGINT NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
      hedge_price DECIMAL(10, 6),
      hedge_time BIGINT,
      exit_price DECIMAL(10, 6),
      exit_time BIGINT,
      pnl DECIMAL(12, 2),
      up_asset_id VARCHAR(255) NOT NULL,
      down_asset_id VARCHAR(255) NOT NULL,
      confidence INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS trades (
      id SERIAL PRIMARY KEY,
      position_id VARCHAR(255) REFERENCES positions(id),
      coin VARCHAR(10) NOT NULL,
      side VARCHAR(10) NOT NULL,
      action VARCHAR(10) NOT NULL,
      token_id VARCHAR(255) NOT NULL,
      shares INTEGER NOT NULL,
      price DECIMAL(10, 6) NOT NULL,
      cost DECIMAL(12, 2) NOT NULL,
      current_price DECIMAL(12, 2) NOT NULL,
      up_balance INTEGER DEFAULT 0,
      down_balance INTEGER DEFAULT 0,
      imbalance INTEGER DEFAULT 0,
      reason TEXT,
      executed BOOLEAN DEFAULT FALSE,
      error TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS market_snapshots (
      id SERIAL PRIMARY KEY,
      coin VARCHAR(10) NOT NULL,
      market_slug VARCHAR(255) NOT NULL,
      price DECIMAL(12, 2) NOT NULL,
      price_change_1m DECIMAL(8, 4),
      price_change_5m DECIMAL(8, 4),
      price_change_15m DECIMAL(8, 4),
      volatility DECIMAL(8, 4),
      up_best_bid DECIMAL(10, 6),
      up_best_ask DECIMAL(10, 6),
      down_best_bid DECIMAL(10, 6),
      down_best_ask DECIMAL(10, 6),
      spread DECIMAL(10, 6),
      timestamp BIGINT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS bot_sessions (
      id SERIAL PRIMARY KEY,
      session_id VARCHAR(255) UNIQUE NOT NULL,
      start_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      end_time TIMESTAMP,
      total_trades INTEGER DEFAULT 0,
      total_pnl DECIMAL(12, 2) DEFAULT 0,
      status VARCHAR(20) DEFAULT 'ACTIVE'
      );

      CREATE INDEX IF NOT EXISTS idx_positions_coin ON positions(coin);
      CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
      CREATE INDEX IF NOT EXISTS idx_positions_market_end_time ON positions(market_end_time);
      CREATE INDEX IF NOT EXISTS idx_trades_position_id ON trades(position_id);
      CREATE INDEX IF NOT EXISTS idx_trades_created_at ON trades(created_at);
      CREATE INDEX IF NOT EXISTS idx_market_snapshots_coin_timestamp
      ON market_snapshots(coin, timestamp);
   `;

      await this.pool.query(schemaSQL);
      console.log('🗄️ Database schema ensured');
   }

  private async initializeSession(): Promise<void> {
    try {
      await this.ensureSchema();
      await this.pool.query(
        'INSERT INTO bot_sessions (session_id, status) VALUES ($1, $2)',
        [this.sessionId, 'ACTIVE']
      );
      console.log(`📊 Database session started: ${this.sessionId}`);
    } catch (error) {
      console.error('Failed to initialize session:', error);
    }
  }

  async query(text: string, params?: any[]): Promise<QueryResult> {
    const client = await this.pool.connect();
    try {
      return await client.query(text, params);
    } finally {
      client.release();
    }
  }

  async transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // ========== POSITION OPERATIONS ==========

  async insertPosition(position: Position): Promise<void> {
    const query = `
      INSERT INTO positions (
        id, coin, market_id, market_slug, side, entry_price, shares, 
        cost_basis, entry_time, hour_open_price, market_end_time, 
        status, up_asset_id, down_asset_id, confidence
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
    `;

    await this.query(query, [
      position.id,
      position.coin,
      position.marketId,
      position.marketSlug,
      position.side,
      position.entryPrice,
      position.shares,
      position.costBasis,
      position.entryTime,
      position.hourOpenPrice,
      position.marketEndTime,
      position.status,
      position.assetIds.up,
      position.assetIds.down,
      position.confidence,
    ]);
  }

  async updatePosition(id: string, updates: Partial<Position>): Promise<void> {
    const fields: string[] = [];
    const values: any[] = [];
    let paramCount = 1;

    if (updates.status !== undefined) {
      fields.push(`status = $${paramCount++}`);
      values.push(updates.status);
    }
    if (updates.hedgePrice !== undefined) {
      fields.push(`hedge_price = $${paramCount++}`);
      values.push(updates.hedgePrice);
    }
    if (updates.hedgeTime !== undefined) {
      fields.push(`hedge_time = $${paramCount++}`);
      values.push(updates.hedgeTime);
    }
    if (updates.exitPrice !== undefined) {
      fields.push(`exit_price = $${paramCount++}`);
      values.push(updates.exitPrice);
    }
    if (updates.exitTime !== undefined) {
      fields.push(`exit_time = $${paramCount++}`);
      values.push(updates.exitTime);
    }
    if (updates.pnl !== undefined) {
      fields.push(`pnl = $${paramCount++}`);
      values.push(updates.pnl);
    }

    if (fields.length === 0) return;

    fields.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);

    const query = `UPDATE positions SET ${fields.join(', ')} WHERE id = $${paramCount}`;
    await this.query(query, values);
  }

  async getPosition(id: string): Promise<Position | null> {
    const result = await this.query('SELECT * FROM positions WHERE id = $1', [id]);
    
    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return this.rowToPosition(row);
  }

  async getOpenPositions(): Promise<Position[]> {
    const result = await this.query(
      'SELECT * FROM positions WHERE status = $1 ORDER BY entry_time DESC',
      ['OPEN']
    );
    
    return result.rows.map(this.rowToPosition);
  }

  async getActivePositionForMarket(coin: string, marketSlug: string): Promise<Position | null> {
    const result = await this.query(
      'SELECT * FROM positions WHERE coin = $1 AND market_slug = $2 AND status = $3 ORDER BY entry_time DESC LIMIT 1',
      [coin, marketSlug, 'OPEN']
    );
    
    if (result.rows.length === 0) return null;
    return this.rowToPosition(result.rows[0]);
  }

  private rowToPosition(row: any): Position {
    return {
      id: row.id,
      coin: row.coin,
      marketId: row.market_id,
      marketSlug: row.market_slug,
      side: row.side,
      entryPrice: parseFloat(row.entry_price),
      shares: row.shares,
      costBasis: parseFloat(row.cost_basis),
      entryTime: parseInt(row.entry_time),
      hourOpenPrice: parseFloat(row.hour_open_price),
      marketEndTime: parseInt(row.market_end_time),
      status: row.status,
      hedgePrice: row.hedge_price ? parseFloat(row.hedge_price) : undefined,
      hedgeTime: row.hedge_time ? parseInt(row.hedge_time) : undefined,
      exitPrice: row.exit_price ? parseFloat(row.exit_price) : undefined,
      exitTime: row.exit_time ? parseInt(row.exit_time) : undefined,
      pnl: row.pnl ? parseFloat(row.pnl) : undefined,
      assetIds: {
        up: row.up_asset_id,
        down: row.down_asset_id,
      },
      confidence: row.confidence,
      upBalance: row.up_balance || 0,
      downBalance: row.down_balance || 0,
    };
  }

  // ========== TRADE OPERATIONS ==========

  async insertTrade(trade: {
    positionId: string;
    coin: string;
    side: 'UP' | 'DOWN';
    action: 'BUY' | 'SELL';
    tokenId: string;
    shares: number;
    price: number;
    cost: number;
    currentPrice: number;
    upBalance: number;
    downBalance: number;
    imbalance: number;
    reason: string;
    executed: boolean;
    error?: string;
  }): Promise<void> {
    const query = `
      INSERT INTO trades (
        position_id, coin, side, action, token_id, shares, price, 
        cost, current_price, up_balance, down_balance, imbalance, 
        reason, executed, error
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
    `;

    await this.query(query, [
      trade.positionId,
      trade.coin,
      trade.side,
      trade.action,
      trade.tokenId,
      trade.shares,
      trade.price,
      trade.cost,
      trade.currentPrice,
      trade.upBalance,
      trade.downBalance,
      trade.imbalance,
      trade.reason,
      trade.executed,
      trade.error || null,
    ]);
  }

  async getTradesForPosition(positionId: string): Promise<any[]> {
    const result = await this.query(
      'SELECT * FROM trades WHERE position_id = $1 ORDER BY created_at ASC',
      [positionId]
    );
    return result.rows;
  }

  // ========== SNAPSHOT OPERATIONS ==========

  async insertSnapshot(snapshot: {
    coin: string;
    marketSlug: string;
    price: number;
    priceChange1m?: number;
    priceChange5m?: number;
    priceChange15m?: number;
    volatility?: number;
    upBestBid?: number;
    upBestAsk?: number;
    downBestBid?: number;
    downBestAsk?: number;
    spread?: number;
    timestamp: number;
  }): Promise<void> {
    const query = `
      INSERT INTO market_snapshots (
        coin, market_slug, price, price_change_1m, price_change_5m, 
        price_change_15m, volatility, up_best_bid, up_best_ask, 
        down_best_bid, down_best_ask, spread, timestamp
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    `;

    await this.query(query, [
      snapshot.coin,
      snapshot.marketSlug,
      snapshot.price,
      snapshot.priceChange1m || null,
      snapshot.priceChange5m || null,
      snapshot.priceChange15m || null,
      snapshot.volatility || null,
      snapshot.upBestBid || null,
      snapshot.upBestAsk || null,
      snapshot.downBestBid || null,
      snapshot.downBestAsk || null,
      snapshot.spread || null,
      snapshot.timestamp,
    ]);
  }

  // ========== STATS ==========

  async getStats(): Promise<any> {
    const result = await this.query(`
      SELECT 
        COUNT(*) as total_positions,
        COUNT(*) FILTER (WHERE status = 'OPEN') as open_positions,
        COUNT(*) FILTER (WHERE status = 'CLOSED') as closed_positions,
        COUNT(*) FILTER (WHERE status = 'HEDGED') as hedged_positions,
        COALESCE(SUM(pnl), 0) as total_pnl,
        COALESCE(SUM(cost_basis) FILTER (WHERE status = 'OPEN'), 0) as total_exposure
      FROM positions
    `);

    const tradesResult = await this.query('SELECT COUNT(*) as total_trades FROM trades');

    return {
      ...result.rows[0],
      total_trades: tradesResult.rows[0].total_trades,
    };
  }

  async updateSessionStats(): Promise<void> {
    const stats = await this.getStats();
    
    await this.query(
      'UPDATE bot_sessions SET total_trades = $1, total_pnl = $2, updated_at = CURRENT_TIMESTAMP WHERE session_id = $3',
      [stats.total_trades, stats.total_pnl, this.sessionId]
    );
  }

  async endSession(): Promise<void> {
    await this.query(
      'UPDATE bot_sessions SET end_time = CURRENT_TIMESTAMP, status = $1 WHERE session_id = $2',
      ['COMPLETED', this.sessionId]
    );
  }

  async close(): Promise<void> {
    await this.endSession();
    await this.pool.end();
    console.log('📊 Database connection closed');
  }

  // ========== HEALTH CHECK ==========

  async healthCheck(): Promise<boolean> {
    try {
      await this.query('SELECT 1');
      return true;
    } catch (error) {
      console.error('Database health check failed:', error);
      return false;
    }
  }
}
