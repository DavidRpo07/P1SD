import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Pool } from 'pg';
import { createPostgresPoolConfig } from '@groupsapp/contracts/postgres';
import { DomainEvent } from './event.types';
import { RabbitEventPublisher } from './rabbit-event.publisher';

interface OutboxRow {
  outbox_id: string | number;
  event_id: string;
  event_type: string;
  routing_key: string;
  payload: Record<string, unknown>;
  occurred_at: string | Date;
  trace_id: string;
  producer: string;
  attempts: number;
}

@Injectable()
export class OutboxRelayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelayService.name);
  private readonly pool = new Pool(createPostgresPoolConfig('groupsapp'));

  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(private readonly rabbitEventPublisher: RabbitEventPublisher) {}

  async onModuleInit() {
    await this.ensureOutboxSchema();
    const intervalMs = Number(process.env.OUTBOX_POLL_INTERVAL_MS || '2000');
    this.timer = setInterval(() => {
      void this.drain();
    }, intervalMs);
    void this.drain();
    this.logger.log(`Outbox relay activo (interval ${intervalMs}ms)`);
  }

  async onModuleDestroy() {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
    }
    await this.pool.end();
  }

  private async drain() {
    if (this.running || this.stopped) {
      return;
    }

    this.running = true;
    try {
      const batchSize = Number(process.env.OUTBOX_BATCH_SIZE || '20');
      const leaseSeconds = Number(process.env.OUTBOX_LEASE_SECONDS || '15');

      const claimed = await this.pool.query<OutboxRow>(
        `WITH picked AS (
          SELECT outbox_id
          FROM msg.outbox
          WHERE published_at IS NULL
            AND next_attempt_at <= NOW()
          ORDER BY outbox_id
          FOR UPDATE SKIP LOCKED
          LIMIT $1
        )
        UPDATE msg.outbox o
        SET next_attempt_at = NOW() + make_interval(secs => $2)
        FROM picked
        WHERE o.outbox_id = picked.outbox_id
        RETURNING o.outbox_id, o.event_id, o.event_type, o.routing_key, o.payload,
                  o.occurred_at, o.trace_id, o.producer, o.attempts`,
        [batchSize, leaseSeconds]
      );

      for (const row of claimed.rows) {
        await this.publishOne(row);
      }
    } catch (error) {
      this.logger.error(`Fallo drenando outbox: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  private async publishOne(row: OutboxRow) {
    const event: DomainEvent = {
      event_id: row.event_id,
      event_type: row.event_type,
      schema_version: 1,
      occurred_at: row.occurred_at instanceof Date ? row.occurred_at.toISOString() : String(row.occurred_at),
      trace_id: row.trace_id,
      producer: row.producer,
      payload: row.payload
    };

    try {
      await this.rabbitEventPublisher.publish(event, row.routing_key);
      await this.pool.query(
        `UPDATE msg.outbox
         SET published_at = NOW(), last_error = NULL
         WHERE outbox_id = $1`,
        [row.outbox_id]
      );
    } catch (error) {
      const nextAttempt = this.backoffSeconds(row.attempts + 1);
      await this.pool.query(
        `UPDATE msg.outbox
         SET attempts = attempts + 1,
             last_error = $2,
             next_attempt_at = NOW() + make_interval(secs => $3)
         WHERE outbox_id = $1`,
        [row.outbox_id, (error as Error).message.slice(0, 500), nextAttempt]
      );
    }
  }

  private backoffSeconds(attempt: number) {
    // 2, 4, 8, ... capped at 60s
    return Math.min(60, Math.max(2, 2 ** attempt));
  }

  private async ensureOutboxSchema() {
    const schemaLockId = 9245301;
    await this.pool.query(`SELECT pg_advisory_lock($1)`, [schemaLockId]);
    try {
      await this.pool.query(`CREATE SCHEMA IF NOT EXISTS msg`);
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS msg.outbox (
          outbox_id BIGSERIAL PRIMARY KEY,
          event_id UUID NOT NULL UNIQUE,
          event_type TEXT NOT NULL,
          routing_key TEXT NOT NULL,
          payload JSONB NOT NULL,
          occurred_at TIMESTAMPTZ NOT NULL,
          trace_id UUID NOT NULL,
          producer TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_error TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          published_at TIMESTAMPTZ
        )
      `);
      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS outbox_pending_idx
        ON msg.outbox (published_at, next_attempt_at, outbox_id)
        WHERE published_at IS NULL
      `);
    } finally {
      await this.pool.query(`SELECT pg_advisory_unlock($1)`, [schemaLockId]);
    }
  }
}
