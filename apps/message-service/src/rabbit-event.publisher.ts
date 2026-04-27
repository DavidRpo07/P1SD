import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { connect, ChannelModel, ConfirmChannel } from 'amqplib';
import { DomainEvent } from './event.types';

@Injectable()
export class RabbitEventPublisher implements OnModuleDestroy {
  private readonly logger = new Logger(RabbitEventPublisher.name);
  private connection: ChannelModel | null = null;
  private channel: ConfirmChannel | null = null;

  async publish(event: DomainEvent, routingKey = event.event_type): Promise<void> {
    await this.ensureChannel();
    if (!this.channel) {
      throw new Error('RABBIT_CHANNEL_NOT_READY');
    }

    const exchange = process.env.RABBITMQ_EXCHANGE || 'groupsapp.events.v1';
    const ok = this.channel.publish(exchange, routingKey, Buffer.from(JSON.stringify(event)), {
      contentType: 'application/json',
      persistent: true,
      messageId: event.event_id,
      type: event.event_type,
      timestamp: Date.parse(event.occurred_at)
    });

    if (!ok) {
      this.logger.warn(`Backpressure al publicar evento ${event.event_type}`);
    }

    await this.channel.waitForConfirms();
  }

  async onModuleDestroy() {
    await this.channel?.close();
    await this.connection?.close();
  }

  private async ensureChannel() {
    if (this.channel) {
      return;
    }

    const url = process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672';
    this.connection = await connect(url);
    this.channel = await this.connection.createConfirmChannel();

    const exchange = process.env.RABBITMQ_EXCHANGE || 'groupsapp.events.v1';
    await this.channel.assertExchange(exchange, 'topic', { durable: true });
  }
}
