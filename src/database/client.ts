// src/database/client.ts
import { EventEmitter } from 'events';
import { Pool, PoolClient, QueryResult } from 'pg';
import { Position } from '../types';

type PendingOp = {
  id: string;
  type: 'query' | 'transaction';
  payload: {
    text?: string;
    params?: any[];
    // for transaction, callback will be set
    callback?: (client: PoolClient) => Promise<any>;
  };
  resolve: (value: any) => void;
  reject: (err: any) => void;
  createdAt: number;
};

export class DatabaseClient extends EventEmitter {
  private pool: Pool;
  private sessionId: string;
  private isHealthy: boolean = true;
  private healthIntervalMs: number = 5000;
  private healthTimer?: NodeJS.Timeout;
  private reconnecting: boolean = false;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 20;
  private pendingQueue: PendingOp[] = [];
  private maxPendingQueueSize: number = 5000; // guard
  private shuttingDown: boolean = false;

  constructor() {
    super();

    this.pool = this.createPool();
    this.sessionId = this.newSessionId();
    // initialize schema + session; if this fails, constructor won't throw but will log and mark unhealthy
    this.initializeSession().catch((err) => {
      console.error('Initial DB setup failed:', err);
      // start health check and reconnect loop
      this.isHealthy = false;
    });

    // start periodic health check
    this.startHealthCheck();
  }

  // -------------------------
  // Pool creation & helpers
  // -------------------------
  private createPool(): Pool {
    return new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
  }

  private newSessionId(): string {
    return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  // -------------------------
  // Schema & session init
  // -------------------------
  private async ensureSchema(poolToUse?: Pool): Promise<void> {
    const pool = poolToUse ?? this.pool;
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
    await pool.query(schemaSQL);
  }

  private async initializeSession(): Promise<void> {
    try {
      await this.ensureSchema(this.pool);
      await this.pool.query(
        'INSERT INTO bot_sessions (session_id, status) VALUES ($1, $2)',
        [this.sessionId, 'ACTIVE']
      );
      console.log(`📊 Database session started: ${this.sessionId}`);
      this.isHealthy = true;
      this.emit('connected');
    } catch (error) {
      console.error('Failed to initialize session:', error);
      this.isHealthy = false;
      this.emit('disconnected', error);
      // start reconnect attempts (health check loop will run)
    }
  }

  // -------------------------
  // Health checking & reconnect
  // -------------------------
  private startHealthCheck() {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = setInterval(async () => {
      if (this.shuttingDown) return;
      try {
        await this.pool.query('SELECT 1');
        if (!this.isHealthy) {
          console.log('✅ Database connection restored (health check).');
          this.isHealthy = true;
          this.reconnectAttempts = 0;
          await this.onReconnectSuccess();
        }
      } catch (err) {
        if (this.isHealthy) {
          console.error('⚠️ Database health check failed:', err);
          this.isHealthy = false;
          this.emit('disconnected', err);
        }
        // attempt reconnect loop if not currently reconnecting
        if (!this.reconnecting) {
          this.attemptReconnect().catch((e) => {
            // attemptReconnect logs errors
          });
        }
      }
    }, this.healthIntervalMs);
  }

  private async attemptReconnect(): Promise<void> {
    this.reconnecting = true;
    this.reconnectAttempts = Math.min(this.reconnectAttempts + 1, this.maxReconnectAttempts);

    const backoffMs = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 60_000);
    console.log(`🔁 Attempting DB reconnect (attempt ${this.reconnectAttempts}) in ${backoffMs}ms...`);

    await this.delay(backoffMs);

    if (this.shuttingDown) {
      this.reconnecting = false;
      return;
    }

    try {
      // create a temporary pool to test the connection first
      const testPool = this.createPool();
      // ensure schema on test pool (this validates the connection and permissions)
      await this.ensureSchema(testPool);
      // if success, swap pools
      const oldPool = this.pool;
      this.pool = testPool;
      this.sessionId = this.newSessionId();
      await this.pool.query('INSERT INTO bot_sessions (session_id, status) VALUES ($1, $2)', [
        this.sessionId,
        'ACTIVE',
      ]);
      console.log(`🔌 Reconnected to DB and started new session ${this.sessionId}`);
      this.isHealthy = true;
      this.reconnectAttempts = 0;
      this.emit('reconnected');
      // close old pool gracefully
      try {
        await oldPool.end();
      } catch (e) {
        console.warn('Error closing old pool after reconnect:', e);
      }
      // process pending queue
      await this.onReconnectSuccess();
    } catch (err) {
      console.error('Reconnect attempt failed:', err);
      this.isHealthy = false;
      // schedule next attempt via health check interval (reconnecting flag reset)
    } finally {
      this.reconnecting = false;
    }
  }

  private async onReconnectSuccess(): Promise<void> {
    // Process the pending queue (sequentially, preserving order)
    if (this.pendingQueue.length === 0) {
      return;
    }
    console.log(`📬 Processing ${this.pendingQueue.length} pending DB operations...`);
    const queue = this.pendingQueue.splice(0); // take snapshot and clear queue
    for (const item of queue) {
      try {
        if (item.type === 'query') {
          const res = await this._immediateQuery(item.payload.text!, item.payload.params);
          item.resolve(res);
        } else if (item.type === 'transaction') {
          try {
            const val = await this._immediateTransaction(item.payload.callback!);
            item.resolve(val);
          } catch (txErr) {
            item.reject(txErr);
          }
        } else {
          item.reject(new Error('Unknown pending op type'));
        }
      } catch (err) {
        // If execution fails even after reconnect, reject that op so caller knows
        item.reject(err);
      }
    }
    console.log('📬 Pending DB operations processed');
  }

  private delay(ms: number) {
    return new Promise((res) => setTimeout(res, ms));
  }

  // -------------------------
  // Query & Transaction APIs
  // -------------------------
  // internal immediate query that throws on failure
  private async _immediateQuery(text: string, params?: any[]): Promise<QueryResult> {
    const client = await this.pool.connect();
    try {
      return await client.query(text, params);
    } finally {
      client.release();
    }
  }

  // public query API (queues when DB is unhealthy)
  async query(text: string, params?: any[]): Promise<QueryResult> {
    if (this.shuttingDown) {
      throw new Error('DatabaseClient is shutting down');
    }

    if (this.isHealthy) {
      try {
        return await this._immediateQuery(text, params);
      } catch (err) {
        console.error('Query failed while healthy — marking unhealthy and queueing:', err);
        // mark unhealthy and fallthrough to queue behavior
        this.isHealthy = false;
        this.emit('disconnected', err);
        // start reconnect attempts
        if (!this.reconnecting) {
          this.attemptReconnect().catch(() => {});
        }
      }
    }

    // Queue the query and return a Promise that will resolve when processed
    if (this.pendingQueue.length >= this.maxPendingQueueSize) {
      throw new Error('Pending DB queue full — rejecting new query');
    }

    return new Promise<QueryResult>((resolve, reject) => {
      const op: PendingOp = {
        id: `q_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
        type: 'query',
        payload: { text, params },
        resolve,
        reject,
        createdAt: Date.now(),
      };
      this.pendingQueue.push(op);
      // ensure reconnect loop is running
      if (!this.reconnecting) {
        this.attemptReconnect().catch(() => {});
      }
    });
  }

  // internal immediate transaction (throws on failure)
  private async _immediateTransaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rbErr) {
        console.error('Rollback failed:', rbErr);
      }
      throw err;
    } finally {
      client.release();
    }
  }

  // public transaction API
  async transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    if (this.shuttingDown) {
      throw new Error('DatabaseClient is shutting down');
    }

    if (this.isHealthy) {
      try {
        return await this._immediateTransaction(callback);
      } catch (err) {
        console.error('Transaction failed while healthy — marking unhealthy and queueing:', err);
        this.isHealthy = false;
        this.emit('disconnected', err);
        if (!this.reconnecting) {
          this.attemptReconnect().catch(() => {});
        }
      }
    }

    if (this.pendingQueue.length >= this.maxPendingQueueSize) {
      throw new Error('Pending DB queue full — rejecting new transaction');
    }

    return new Promise<T>((resolve, reject) => {
      const op: PendingOp = {
        id: `t_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
        type: 'transaction',
        payload: { callback },
        resolve,
        reject,
        createdAt: Date.now(),
      };
      this.pendingQueue.push(op);
      if (!this.reconnecting) {
        this.attemptReconnect().catch(() => {});
      }
    });
  }

  // -------------------------
  // Original operations (unchanged behavior)
  // -------------------------
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
      'UPDATE bot_sessions SET total_trades = $1, total_pnl = $2 WHERE session_id = $3',
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
    this.shuttingDown = true;
    if (this.healthTimer) clearInterval(this.healthTimer);
    try {
      await this.endSession();
    } catch (e) {
      console.warn('Error ending session during close:', e);
    }
    try {
      await this.pool.end();
      console.log('📊 Database connection closed');
    } catch (err) {
      console.error('Error closing DB pool:', err);
    }
  }

  // ========== HEALTH CHECK (public) ==========
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
