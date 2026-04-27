import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Channel, ChannelModel, ConsumeMessage, connect } from 'amqplib';
import { Pool } from 'pg';

interface DomainEvent {
  event_id: string;
  event_type: string;
  schema_version: number;
  occurred_at: string;
  trace_id: string;
  producer: string;
  payload: Record<string, unknown>;
}

@Injectable()
export class NotificationConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationConsumerService.name);

  private readonly pool = new Pool({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: Number(process.env.POSTGRES_PORT || '5432'),
    user: process.env.POSTGRES_USER || 'groupsapp',
    password: process.env.POSTGRES_PASSWORD || 'groupsapp',
    database: process.env.POSTGRES_DB || 'groupsapp'
  });

  private connection: ChannelModel | null = null;
  private channel: Channel | null = null;
  private stopped = false;

  private readonly consumerName = 'notification-service';

  async onModuleInit() {
    await this.initSchema();
    void this.connectWithRetry();
  }

  async onModuleDestroy() {
    this.stopped = true;
    await this.channel?.close();
    await this.connection?.close();
    await this.pool.end();
  }

  private async connectWithRetry() {
    const delayMs = Number(process.env.NOTIFICATION_CONNECT_RETRY_MS || '2000');

    while (!this.stopped) {
      try {
        await this.initBroker();
        return;
      } catch (error) {
        this.logger.warn(`No se pudo conectar al broker: ${(error as Error).message}. Reintento en ${delayMs}ms`);
        await this.closeBrokerHandles();
        await this.sleep(delayMs);
      }
    }
  }

  private async initSchema() {
    await this.pool.query(`CREATE SCHEMA IF NOT EXISTS notif`);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS notif.processed_events (
        consumer_name TEXT NOT NULL,
        event_id UUID NOT NULL,
        processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (consumer_name, event_id)
      )
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS notif.notifications_log (
        log_id BIGSERIAL PRIMARY KEY,
        event_id UUID NOT NULL,
        event_type TEXT NOT NULL,
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }

  private async initBroker() {
    const rabbitUrl = process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672';
    this.connection = await connect(rabbitUrl);
    this.channel = await this.connection.createChannel();

    const eventsExchange = process.env.RABBITMQ_EXCHANGE || 'groupsapp.events.v1';
    const retryExchange = process.env.RABBITMQ_RETRY_EXCHANGE || 'groupsapp.retry.v1';
    const dlxExchange = process.env.RABBITMQ_DLX_EXCHANGE || 'groupsapp.dlx.v1';

    const queueName = process.env.NOTIFICATION_QUEUE || 'notification.message-created';
    const retryQueue = process.env.NOTIFICATION_RETRY_QUEUE || 'notification.message-created.retry';
    const dlqName = process.env.NOTIFICATION_DLQ || 'notification.message-created.dlq';

    const mainRoutingKey = 'message.created';
    const retryRoutingKey = 'message.created.retry';
    const dlqRoutingKey = 'message.created.dlq';

    const retryTtlMs = Number(process.env.NOTIFICATION_RETRY_TTL_MS || '5000');

    await this.channel.assertExchange(eventsExchange, 'topic', { durable: true });
    await this.channel.assertExchange(retryExchange, 'direct', { durable: true });
    await this.channel.assertExchange(dlxExchange, 'topic', { durable: true });

    await this.channel.assertQueue(queueName, {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': dlxExchange,
        'x-dead-letter-routing-key': dlqRoutingKey
      }
    });
    await this.channel.bindQueue(queueName, eventsExchange, mainRoutingKey);

    await this.channel.assertQueue(retryQueue, {
      durable: true,
      arguments: {
        'x-message-ttl': retryTtlMs,
        'x-dead-letter-exchange': eventsExchange,
        'x-dead-letter-routing-key': mainRoutingKey
      }
    });
    await this.channel.bindQueue(retryQueue, retryExchange, retryRoutingKey);

    await this.channel.assertQueue(dlqName, { durable: true });
    await this.channel.bindQueue(dlqName, dlxExchange, dlqRoutingKey);

    await this.channel.prefetch(Number(process.env.NOTIFICATION_PREFETCH || '20'));

    await this.channel.consume(queueName, (msg) => {
      void this.handleMessage(msg, retryExchange, retryRoutingKey, dlxExchange, dlqRoutingKey);
    });

    this.logger.log(
      `Consumer activo. queue=${queueName}, retry=${retryQueue}, dlq=${dlqName}, retry_ttl_ms=${retryTtlMs}`
    );
  }

  private async handleMessage(
    msg: ConsumeMessage | null,
    retryExchange: string,
    retryRoutingKey: string,
    dlxExchange: string,
    dlqRoutingKey: string
  ) {
    if (!msg || !this.channel) {
      return;
    }

    let parsed: DomainEvent | null = null;

    try {
      parsed = JSON.parse(msg.content.toString()) as DomainEvent;
      if (!parsed.event_id) {
        throw new Error('EVENT_ID_MISSING');
      }

      await this.processEvent(parsed);
      this.channel.ack(msg);
    } catch (error) {
      const maxRetries = Number(process.env.NOTIFICATION_MAX_RETRIES || '3');
      const retryCount = this.extractRetryCount(msg);

      try {
        if (retryCount < maxRetries) {
          this.channel.publish(retryExchange, retryRoutingKey, msg.content, {
            persistent: true,
            contentType: 'application/json',
            messageId: parsed?.event_id || msg.properties.messageId,
            headers: {
              ...(msg.properties.headers || {}),
              'x-retry-count': retryCount + 1,
              'x-last-error': (error as Error).message
            }
          });
          this.logger.warn(
            `Retry ${retryCount + 1}/${maxRetries} para evento ${parsed?.event_id || 'unknown'}: ${(error as Error).message}`
          );
        } else {
          this.channel.publish(dlxExchange, dlqRoutingKey, msg.content, {
            persistent: true,
            contentType: 'application/json',
            messageId: parsed?.event_id || msg.properties.messageId,
            headers: {
              ...(msg.properties.headers || {}),
              'x-retry-count': retryCount,
              'x-last-error': (error as Error).message
            }
          });
          this.logger.error(
            `Evento enviado a DLQ tras ${retryCount} reintentos. event=${parsed?.event_id || 'unknown'}`
          );
        }

        this.channel.ack(msg);
      } catch (publishError) {
        this.logger.error(`Fallo enviando a retry/DLQ: ${(publishError as Error).message}`);
        this.channel.nack(msg, false, true);
      }
    }
  }

  private async processEvent(event: DomainEvent) {
    if (this.shouldForceFail()) {
      throw new Error('FORCED_FAILURE_FOR_DEMO');
    }

    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      const inserted = await client.query(
        `INSERT INTO notif.processed_events (consumer_name, event_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING
         RETURNING event_id`,
        [this.consumerName, event.event_id]
      );

      if (!inserted.rows.length) {
        await client.query('COMMIT');
        return;
      }

      await client.query(
        `INSERT INTO notif.notifications_log (event_id, event_type, payload)
         VALUES ($1, $2, $3::jsonb)`,
        [event.event_id, event.event_type, JSON.stringify(event.payload)]
      );

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private extractRetryCount(msg: ConsumeMessage) {
    const raw = msg.properties.headers?.['x-retry-count'];
    const numeric = Number(raw);
    return Number.isFinite(numeric) ? numeric : 0;
  }

  private shouldForceFail() {
    const mode = (process.env.NOTIFICATION_FAIL_MODE || 'off').toLowerCase();
    return mode === 'always';
  }

  private async closeBrokerHandles() {
    try {
      await this.channel?.close();
    } catch {
      // ignore
    }
    try {
      await this.connection?.close();
    } catch {
      // ignore
    }
    this.channel = null;
    this.connection = null;
  }

  private async sleep(ms: number) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
