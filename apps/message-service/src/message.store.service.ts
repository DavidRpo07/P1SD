import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit
} from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { Pool, PoolClient } from 'pg';
import { createPostgresPoolConfig } from '@groupsapp/contracts/postgres';
import { lastValueFrom } from 'rxjs';
import { v7 as uuidv7 } from 'uuid';
import { GroupGrpcService, UserGrpcService } from './contracts';
import { DomainEvent } from './event.types';
import { S3AttachmentsService } from './s3-attachments.service';

interface MessageRow {
  message_id: string;
  channel_id: string;
  shard_id?: string | number;
  sender_user_id: string;
  body: string;
  seq: string | number;
  created_at: string | Date;
  delivered_count?: string | number;
  read_count?: string | number;
  requester_has_delivered?: boolean;
  requester_has_read?: boolean;
}

interface AttachmentRow {
  attachment_id: string;
  owner_user_id: string;
  object_key: string;
  file_name: string;
  content_type: string;
  size_bytes: string | number;
  status: string;
  created_at: string | Date;
}

interface AttachmentEntity {
  attachment_id: string;
  owner_user_id: string;
  file_name: string;
  content_type: string;
  size_bytes: number;
  status: string;
  created_at: string;
  download_url: string;
}

@Injectable()
export class MessageStoreService implements OnModuleInit, OnModuleDestroy {
  private groupGrpcService!: GroupGrpcService;
  private userGrpcService!: UserGrpcService;
  private readonly messageShards = Math.max(2, Number(process.env.MESSAGE_SHARDS || '16'));

  private readonly pool = new Pool(createPostgresPoolConfig('groupsapp'));

  constructor(
    @Inject('GROUP_GRPC') private readonly groupClient: ClientGrpc,
    @Inject('USER_GRPC') private readonly userClient: ClientGrpc,
    private readonly s3AttachmentsService: S3AttachmentsService
  ) {}

  async onModuleInit() {
    this.groupGrpcService = this.groupClient.getService<GroupGrpcService>('GroupService');
    this.userGrpcService = this.userClient.getService<UserGrpcService>('UserService');
    await this.initSchema();
  }

  async onModuleDestroy() {
    await this.pool.end();
  }

  async createAttachmentUpload(data: {
    owner_user_id: string;
    file_name: string;
    content_type: string;
    size_bytes: number;
  }) {
    const fileName = (data.file_name || '').trim();
    const contentType = (data.content_type || '').trim();
    const sizeBytes = Number(data.size_bytes || 0);

    if (!fileName) {
      throw new BadRequestException('ATTACHMENT_FILE_NAME_REQUIRED');
    }
    if (!contentType) {
      throw new BadRequestException('ATTACHMENT_CONTENT_TYPE_REQUIRED');
    }
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
      throw new BadRequestException('ATTACHMENT_SIZE_INVALID');
    }

    const attachmentId = uuidv7();
    const objectKey = this.s3AttachmentsService.buildObjectKey(data.owner_user_id, attachmentId, fileName);
    let uploadUrl = '';
    try {
      uploadUrl = await this.s3AttachmentsService.createUploadUrl(objectKey, contentType);
    } catch {
      throw new BadRequestException('S3_NOT_CONFIGURED');
    }

    await this.pool.query(
      `INSERT INTO msg.attachments (
        attachment_id, owner_user_id, object_key, file_name, content_type, size_bytes, status
      ) VALUES ($1, $2, $3, $4, $5, $6, 'pending_upload')`,
      [attachmentId, data.owner_user_id, objectKey, fileName, contentType, sizeBytes]
    );

    return {
      attachment_id: attachmentId,
      upload_url: uploadUrl,
      method: 'PUT',
      headers: {
        'Content-Type': contentType
      },
      expires_in_seconds: this.s3AttachmentsService.getUploadUrlExpiresIn(),
      file_name: fileName,
      content_type: contentType,
      size_bytes: sizeBytes
    };
  }

  async completeAttachmentUpload(data: { attachment_id: string; requester_user_id: string }) {
    const attachment = await this.getAttachmentById(data.attachment_id);
    if (!attachment) {
      throw new NotFoundException('ATTACHMENT_NOT_FOUND');
    }
    if (attachment.owner_user_id !== data.requester_user_id) {
      throw new ForbiddenException('ATTACHMENT_FORBIDDEN');
    }

    let exists = false;
    try {
      exists = await this.s3AttachmentsService.objectExists(attachment.object_key);
    } catch {
      throw new BadRequestException('S3_NOT_CONFIGURED');
    }
    if (!exists) {
      throw new BadRequestException('ATTACHMENT_OBJECT_NOT_FOUND');
    }

    await this.pool.query(
      `UPDATE msg.attachments
       SET status = 'uploaded', uploaded_at = NOW()
       WHERE attachment_id = $1`,
      [data.attachment_id]
    );

    const refreshed = await this.getAttachmentById(data.attachment_id);
    if (!refreshed) {
      throw new NotFoundException('ATTACHMENT_NOT_FOUND');
    }

    try {
      return this.toAttachmentEntity(refreshed, await this.s3AttachmentsService.createDownloadUrl(refreshed.object_key));
    } catch {
      throw new BadRequestException('S3_NOT_CONFIGURED');
    }
  }

  async getAttachment(data: { attachment_id: string; requester_user_id: string }) {
    const attachment = await this.getAttachmentById(data.attachment_id);
    if (!attachment) {
      throw new NotFoundException('ATTACHMENT_NOT_FOUND');
    }

    const canAccess = await this.canUserAccessAttachment(data.requester_user_id, attachment.attachment_id);
    if (!canAccess) {
      throw new ForbiddenException('ATTACHMENT_FORBIDDEN');
    }

    try {
      const downloadUrl = await this.s3AttachmentsService.createDownloadUrl(attachment.object_key);
      return this.toAttachmentEntity(attachment, downloadUrl);
    } catch {
      throw new BadRequestException('S3_NOT_CONFIGURED');
    }
  }

  async sendChannelMessage(data: {
    channel_id: string;
    sender_user_id: string;
    body: string;
    attachment_ids: string[];
    idempotency_key: string;
  }) {
    const normalizedBody = (data.body || '').trim();
    const normalizedAttachmentIds = this.normalizeAttachmentIds(data.attachment_ids || []);
    if (!normalizedBody && !normalizedAttachmentIds.length) {
      throw new BadRequestException('MSG_EMPTY_NOT_ALLOWED');
    }

    await this.ensureMembership(data.channel_id, data.sender_user_id);
    return this.persistMessage(
      data.channel_id,
      data.sender_user_id,
      normalizedBody,
      normalizedAttachmentIds,
      data.idempotency_key,
      {
        conversation_kind: 'channel'
      }
    );
  }

  async listChannelMessages(data: { channel_id: string; requester_user_id: string; limit: number }) {
    await this.ensureMembership(data.channel_id, data.requester_user_id);
    return this.listMessagesByChannelId(data.channel_id, data.limit, data.requester_user_id);
  }

  async sendDirectMessage(data: {
    sender_user_id: string;
    recipient_user_id: string;
    body: string;
    attachment_ids: string[];
    idempotency_key: string;
  }) {
    const normalizedBody = (data.body || '').trim();
    const normalizedAttachmentIds = this.normalizeAttachmentIds(data.attachment_ids || []);
    if (!normalizedBody && !normalizedAttachmentIds.length) {
      throw new BadRequestException('MSG_EMPTY_NOT_ALLOWED');
    }

    if (data.sender_user_id === data.recipient_user_id) {
      throw new BadRequestException('DM_SELF_NOT_ALLOWED');
    }

    await this.ensureDirectMessagingPolicy(data.sender_user_id, data.recipient_user_id);
    const channelId = await this.resolveDirectChannelId(data.sender_user_id, data.recipient_user_id);

    return this.persistMessage(
      channelId,
      data.sender_user_id,
      normalizedBody,
      normalizedAttachmentIds,
      data.idempotency_key,
      {
        conversation_kind: 'direct',
        recipient_user_id: data.recipient_user_id
      }
    );
  }

  async listDirectMessages(data: { requester_user_id: string; peer_user_id: string; limit: number }) {
    if (data.requester_user_id === data.peer_user_id) {
      throw new BadRequestException('DM_SELF_NOT_ALLOWED');
    }

    await this.ensureDirectMessagingPolicy(data.requester_user_id, data.peer_user_id);
    const channelId = await this.findDirectChannelId(data.requester_user_id, data.peer_user_id);
    if (!channelId) {
      return { items: [] };
    }

    return this.listMessagesByChannelId(channelId, data.limit, data.requester_user_id);
  }

  async markDelivered(data: { message_id: string; user_id: string }) {
    await this.markReceipt({
      messageId: data.message_id,
      userId: data.user_id,
      tableName: 'msg.delivery_receipts',
      timestampColumn: 'delivered_at',
      eventType: 'message.delivered'
    });
    return { ok: true };
  }

  async markRead(data: { message_id: string; user_id: string }) {
    await this.markReceipt({
      messageId: data.message_id,
      userId: data.user_id,
      tableName: 'msg.read_receipts',
      timestampColumn: 'read_at',
      eventType: 'message.read'
    });
    return { ok: true };
  }

  private async listMessagesByChannelId(channelId: string, limit: number, requesterUserId: string) {
    const safeLimit = Math.max(1, Math.min(limit || 50, 200));
    const shardId = this.computeShardId(channelId);
    const result = await this.pool.query<MessageRow>(
      `SELECT
         m.message_id,
         m.channel_id,
         m.sender_user_id,
         m.body,
         m.seq,
         m.created_at,
         COALESCE(dr.delivery_count, 0) AS delivered_count,
         COALESCE(rr.read_count, 0) AS read_count,
         EXISTS (
           SELECT 1
           FROM msg.delivery_receipts dmx
           WHERE dmx.message_id = m.message_id
             AND dmx.user_id = $3
         ) AS requester_has_delivered,
         EXISTS (
           SELECT 1
           FROM msg.read_receipts rmx
           WHERE rmx.message_id = m.message_id
             AND rmx.user_id = $3
         ) AS requester_has_read
       FROM msg.messages m
       LEFT JOIN (
         SELECT d.message_id, COUNT(*)::int AS delivery_count
         FROM msg.delivery_receipts d
         JOIN msg.messages md ON md.message_id = d.message_id
         WHERE d.user_id <> md.sender_user_id
         GROUP BY d.message_id
       ) dr ON dr.message_id = m.message_id
       LEFT JOIN (
         SELECT r.message_id, COUNT(*)::int AS read_count
         FROM msg.read_receipts r
         JOIN msg.messages mr ON mr.message_id = r.message_id
         WHERE r.user_id <> mr.sender_user_id
         GROUP BY r.message_id
       ) rr ON rr.message_id = m.message_id
       WHERE m.channel_id = $1
         AND m.shard_id = $4
       ORDER BY m.seq DESC
       LIMIT $2`,
      [channelId, safeLimit, requesterUserId, shardId]
    );

    const messageIds = result.rows.map((row) => row.message_id);
    const attachmentsByMessageId = await this.fetchAttachmentsByMessageIds(messageIds);

    return {
      items: result.rows.map((row: MessageRow) =>
        this.toMessageEntity(row, requesterUserId, attachmentsByMessageId.get(row.message_id) || [])
      )
    };
  }

  private async persistMessage(
    channelId: string,
    senderUserId: string,
    body: string,
    attachmentIdsRaw: string[],
    idempotencyKeyRaw: string,
    extraPayload: Record<string, unknown>
  ) {
    const idempotencyKey = (idempotencyKeyRaw || '').trim() || null;
    const attachmentIds = attachmentIdsRaw;

    if (idempotencyKey) {
      const existing = await this.findByIdempotency(senderUserId, channelId, idempotencyKey, senderUserId);
      if (existing) {
        return existing;
      }
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { nextSeq, shardId } = await this.incrementAndGetChannelSeq(client, channelId);

      const messageId = uuidv7();
      const inserted = await client.query<MessageRow>(
        `INSERT INTO msg.messages (
          message_id, channel_id, shard_id, sender_user_id, body, seq, idempotency_key
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING message_id, channel_id, shard_id, sender_user_id, body, seq, created_at`,
        [messageId, channelId, shardId, senderUserId, body, nextSeq, idempotencyKey]
      );

      const lockedAttachments = await this.lockAndValidateAttachmentsForSender(client, attachmentIds, senderUserId);
      if (lockedAttachments.length) {
        await this.linkAttachmentsToMessage(client, messageId, lockedAttachments);
      }

      const messageAttachments = await Promise.all(
        lockedAttachments.map(async (attachment) => {
          let downloadUrl = '';
          try {
            downloadUrl = await this.s3AttachmentsService.createDownloadUrl(attachment.object_key);
          } catch {
            downloadUrl = '';
          }
          return this.toAttachmentEntity(attachment, downloadUrl);
        })
      );
      const message = this.toMessageEntity(inserted.rows[0], senderUserId, messageAttachments);
      const event = this.buildEvent('message.created', {
        message_id: message.message_id,
        channel_id: message.channel_id,
        sender_user_id: message.sender_user_id,
        shard_id: shardId,
        seq: message.seq,
        created_at: message.created_at,
        attachment_count: message.attachments.length,
        ...extraPayload
      });
      await this.insertOutboxEvent(client, event);

      await client.query('COMMIT');
      return message;
    } catch (error: unknown) {
      await client.query('ROLLBACK');

      if (idempotencyKey && this.isPgError(error) && error.code === '23505') {
        const existing = await this.findByIdempotency(senderUserId, channelId, idempotencyKey, senderUserId);
        if (existing) {
          return existing;
        }
      }

      throw error;
    } finally {
      client.release();
    }
  }

  private normalizeAttachmentIds(attachmentIds: string[]) {
    const normalized = attachmentIds
      .map((id) => (id || '').trim())
      .filter((id) => !!id);

    return Array.from(new Set(normalized)).slice(0, 10);
  }

  private async lockAndValidateAttachmentsForSender(client: PoolClient, attachmentIds: string[], senderUserId: string) {
    if (!attachmentIds.length) {
      return [];
    }

    const found = await client.query<AttachmentRow>(
      `SELECT attachment_id, owner_user_id, object_key, file_name, content_type, size_bytes, status, created_at
       FROM msg.attachments
       WHERE attachment_id::text = ANY($1::text[])
       FOR UPDATE`,
      [attachmentIds]
    );

    if (found.rows.length !== attachmentIds.length) {
      throw new BadRequestException('ATTACHMENT_NOT_FOUND');
    }

    for (const row of found.rows) {
      if (row.owner_user_id !== senderUserId) {
        throw new ForbiddenException('ATTACHMENT_FORBIDDEN');
      }
      if (row.status !== 'uploaded') {
        throw new BadRequestException('ATTACHMENT_NOT_UPLOADED');
      }
    }

    return found.rows;
  }

  private async linkAttachmentsToMessage(client: PoolClient, messageId: string, attachments: AttachmentRow[]) {
    for (const attachment of attachments) {
      await client.query(
        `INSERT INTO msg.message_attachments (message_id, attachment_id)
         VALUES ($1, $2)
         ON CONFLICT (message_id, attachment_id) DO NOTHING`,
        [messageId, attachment.attachment_id]
      );
    }
  }

  private async fetchAttachmentsByMessageIds(messageIds: string[]) {
    const map = new Map<string, AttachmentEntity[]>();
    if (!messageIds.length) {
      return map;
    }

    const rows = await this.pool.query<AttachmentRow & { message_id: string }>(
      `SELECT
         ma.message_id,
         a.attachment_id,
         a.owner_user_id,
         a.object_key,
         a.file_name,
         a.content_type,
         a.size_bytes,
         a.status,
         a.created_at
       FROM msg.message_attachments ma
       JOIN msg.attachments a ON a.attachment_id = ma.attachment_id
       WHERE ma.message_id::text = ANY($1::text[])
       ORDER BY ma.created_at ASC`,
      [messageIds]
    );

    for (const row of rows.rows) {
      let downloadUrl = '';
      try {
        downloadUrl = await this.s3AttachmentsService.createDownloadUrl(row.object_key);
      } catch {
        downloadUrl = '';
      }

      const attachment = this.toAttachmentEntity(row, downloadUrl);
      const existing: AttachmentEntity[] = map.get(row.message_id) || [];
      existing.push(attachment);
      map.set(row.message_id, existing);
    }

    return map;
  }

  private async getAttachmentById(attachmentId: string) {
    const found = await this.pool.query<AttachmentRow>(
      `SELECT attachment_id, owner_user_id, object_key, file_name, content_type, size_bytes, status, created_at
       FROM msg.attachments
       WHERE attachment_id = $1
       LIMIT 1`,
      [attachmentId]
    );

    return found.rows[0] || null;
  }

  private async canUserAccessAttachment(requesterUserId: string, attachmentId: string) {
    const attachment = await this.getAttachmentById(attachmentId);
    if (!attachment) {
      return false;
    }

    if (attachment.owner_user_id === requesterUserId) {
      return true;
    }

    const channels = await this.pool.query<{ channel_id: string }>(
      `SELECT DISTINCT m.channel_id
       FROM msg.message_attachments ma
       JOIN msg.messages m ON m.message_id = ma.message_id
       WHERE ma.attachment_id = $1`,
      [attachmentId]
    );

    for (const row of channels.rows) {
      try {
        await this.ensureMessageAccess(row.channel_id, requesterUserId);
        return true;
      } catch {
        // continue
      }
    }

    return false;
  }

  private toAttachmentEntity(row: AttachmentRow, downloadUrl: string): AttachmentEntity {
    return {
      attachment_id: row.attachment_id,
      owner_user_id: row.owner_user_id,
      file_name: row.file_name,
      content_type: row.content_type,
      size_bytes: Number(row.size_bytes),
      status: row.status,
      created_at:
        row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
      download_url: downloadUrl
    };
  }

  private async markReceipt(data: {
    messageId: string;
    userId: string;
    tableName: 'msg.delivery_receipts' | 'msg.read_receipts';
    timestampColumn: 'delivered_at' | 'read_at';
    eventType: 'message.delivered' | 'message.read';
  }) {
    const message = await this.findMessageById(data.messageId);
    if (!message) {
      throw new NotFoundException('MSG_NOT_FOUND');
    }

    await this.ensureMessageAccess(message.channel_id, data.userId);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const insertResult = await client.query(
        `INSERT INTO ${data.tableName} (message_id, user_id, ${data.timestampColumn})
         VALUES ($1, $2, NOW())
         ON CONFLICT (message_id, user_id) DO NOTHING
         RETURNING message_id`,
        [data.messageId, data.userId]
      );

      if (insertResult.rows.length) {
        const event = this.buildEvent(data.eventType, {
          message_id: data.messageId,
          channel_id: message.channel_id,
          user_id: data.userId
        });
        await this.insertOutboxEvent(client, event);
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async ensureMessageAccess(channelId: string, userId: string) {
    const directParticipants = await this.pool.query<{ user_a: string; user_b: string }>(
      `SELECT user_a, user_b
       FROM msg.direct_conversations
       WHERE channel_id = $1
       LIMIT 1`,
      [channelId]
    );

    if (directParticipants.rows.length) {
      const row = directParticipants.rows[0];
      const allowed = row.user_a === userId || row.user_b === userId;
      if (!allowed) {
        throw new ForbiddenException('MSG_FORBIDDEN');
      }
      return;
    }

    await this.ensureMembership(channelId, userId);
  }

  private async findMessageById(messageId: string) {
    const found = await this.pool.query<MessageRow>(
      `SELECT message_id, channel_id, sender_user_id, body, seq, created_at
       FROM msg.messages
       WHERE message_id = $1
       LIMIT 1`,
      [messageId]
    );

    return found.rows.length ? this.toMessageEntity(found.rows[0]) : null;
  }

  private async ensureDirectMessagingPolicy(requesterUserId: string, peerUserId: string) {
    const policy = await lastValueFrom(
      this.userGrpcService.CheckDirectMessagingPolicy({
        requester_user_id: requesterUserId,
        peer_user_id: peerUserId
      })
    );

    if (!policy.allowed) {
      throw new ForbiddenException(policy.reason || 'DM_NOT_ALLOWED');
    }
  }

  private async resolveDirectChannelId(userOne: string, userTwo: string) {
    const [userA, userB] = [userOne, userTwo].sort((a, b) => a.localeCompare(b));
    const createdChannelId = uuidv7();

    const res = await this.pool.query<{ channel_id: string }>(
      `INSERT INTO msg.direct_conversations (user_a, user_b, channel_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_a, user_b)
       DO UPDATE SET channel_id = msg.direct_conversations.channel_id
       RETURNING channel_id`,
      [userA, userB, createdChannelId]
    );

    return res.rows[0].channel_id;
  }

  private async findDirectChannelId(userOne: string, userTwo: string) {
    const [userA, userB] = [userOne, userTwo].sort((a, b) => a.localeCompare(b));
    const res = await this.pool.query<{ channel_id: string }>(
      `SELECT channel_id
       FROM msg.direct_conversations
       WHERE user_a = $1 AND user_b = $2
       LIMIT 1`,
      [userA, userB]
    );

    return res.rows[0]?.channel_id || null;
  }

  private async incrementAndGetChannelSeq(client: PoolClient, channelId: string) {
    const computedShardId = this.computeShardId(channelId);
    await client.query(
      `INSERT INTO msg.channel_offsets (channel_id, next_seq, shard_id)
       VALUES ($1, 0, $2)
       ON CONFLICT (channel_id) DO NOTHING`,
      [channelId, computedShardId]
    );

    const offsetRow = await client.query<{ next_seq: string | number; shard_id: string | number }>(
      `SELECT next_seq, shard_id
       FROM msg.channel_offsets
       WHERE channel_id = $1
       FOR UPDATE`,
      [channelId]
    );

    const nextSeq = Number(offsetRow.rows[0].next_seq) + 1;
    const shardId = Number(offsetRow.rows[0].shard_id);
    await client.query(
      `UPDATE msg.channel_offsets
       SET next_seq = $2
       WHERE channel_id = $1`,
      [channelId, nextSeq]
    );

    return { nextSeq, shardId };
  }

  private async findByIdempotency(
    senderUserId: string,
    channelId: string,
    idempotencyKey: string,
    requesterUserId: string
  ) {
    const shardId = this.computeShardId(channelId);
    const found = await this.pool.query<MessageRow>(
      `SELECT message_id, channel_id, shard_id, sender_user_id, body, seq, created_at
       FROM msg.messages
       WHERE sender_user_id = $1 AND channel_id = $2 AND shard_id = $3 AND idempotency_key = $4
       LIMIT 1`,
      [senderUserId, channelId, shardId, idempotencyKey]
    );

    if (!found.rows.length) {
      return null;
    }

    const row = found.rows[0];
    const attachmentsByMessageId = await this.fetchAttachmentsByMessageIds([row.message_id]);
    return this.toMessageEntity(row, requesterUserId, attachmentsByMessageId.get(row.message_id) || []);
  }

  private async ensureMembership(channelId: string, userId: string) {
    let membership: { is_member: boolean; group_id: string };
    try {
      membership = await lastValueFrom(
        this.groupGrpcService.CheckChannelMembership({
          channel_id: channelId,
          user_id: userId
        })
      );
    } catch (error) {
      if (this.isGrpcError(error) && error.code === 5) {
        throw new NotFoundException('CHANNEL_NOT_FOUND');
      }
      if (this.isGrpcError(error) && error.code === 7) {
        throw new ForbiddenException('MSG_NOT_CHANNEL_MEMBER');
      }
      throw error;
    }

    if (!membership.is_member) {
      throw new ForbiddenException('MSG_NOT_CHANNEL_MEMBER');
    }
  }

  private buildEvent(eventType: string, payload: Record<string, unknown>): DomainEvent {
    return {
      event_id: uuidv7(),
      event_type: eventType,
      schema_version: 1,
      occurred_at: new Date().toISOString(),
      trace_id: uuidv7(),
      producer: 'message-service',
      payload
    };
  }

  private async insertOutboxEvent(client: PoolClient, event: DomainEvent) {
    await client.query(
      `INSERT INTO msg.outbox (
        event_id, event_type, routing_key, payload, occurred_at, trace_id, producer
       ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
      [
        event.event_id,
        event.event_type,
        event.event_type,
        JSON.stringify(event.payload),
        event.occurred_at,
        event.trace_id,
        event.producer
      ]
    );
  }

  private async initSchema() {
    const schemaLockId = 9245301;
    await this.pool.query(`SELECT pg_advisory_lock($1)`, [schemaLockId]);
    try {
      await this.pool.query(`CREATE SCHEMA IF NOT EXISTS msg`);

      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS msg.channel_offsets (
          channel_id UUID PRIMARY KEY,
          next_seq BIGINT NOT NULL DEFAULT 0,
          shard_id SMALLINT NOT NULL DEFAULT 0
        )
      `);

      await this.pool.query(`ALTER TABLE msg.channel_offsets ADD COLUMN IF NOT EXISTS shard_id SMALLINT`);
      await this.pool.query(`UPDATE msg.channel_offsets SET shard_id = 0 WHERE shard_id IS NULL`);
      await this.pool.query(`ALTER TABLE msg.channel_offsets ALTER COLUMN shard_id SET DEFAULT 0`);
      await this.pool.query(`ALTER TABLE msg.channel_offsets ALTER COLUMN shard_id SET NOT NULL`);

      await this.pool.query(`
        DO $$
        DECLARE
          relkind_char "char";
          r RECORD;
        BEGIN
          SELECT c.relkind
          INTO relkind_char
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'msg' AND c.relname = 'messages';

          -- Si existe como tabla normal, migramos a particionada HASH(shard_id)
          IF relkind_char = 'r' THEN
            FOR r IN
              SELECT conrelid::regclass AS table_name, conname
              FROM pg_constraint
              WHERE contype = 'f' AND confrelid = 'msg.messages'::regclass
            LOOP
              EXECUTE format('ALTER TABLE %s DROP CONSTRAINT IF EXISTS %I', r.table_name, r.conname);
            END LOOP;

            ALTER TABLE msg.messages RENAME TO messages_legacy;

            CREATE TABLE msg.messages (
              message_id UUID NOT NULL,
              channel_id UUID NOT NULL,
              shard_id SMALLINT NOT NULL DEFAULT 0,
              sender_user_id UUID NOT NULL,
              body TEXT NOT NULL,
              seq BIGINT NOT NULL,
              idempotency_key TEXT,
              created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
              UNIQUE (shard_id, channel_id, seq)
            ) PARTITION BY HASH (shard_id);

            FOR r IN
              SELECT i::TEXT AS partition_idx
              FROM generate_series(0, ${this.messageShards - 1}) AS i
            LOOP
              EXECUTE format(
                'CREATE TABLE IF NOT EXISTS msg.messages_p%s PARTITION OF msg.messages FOR VALUES WITH (MODULUS ${this.messageShards}, REMAINDER %s)',
                r.partition_idx,
                r.partition_idx
              );
            END LOOP;

            INSERT INTO msg.messages (
              message_id, channel_id, shard_id, sender_user_id, body, seq, idempotency_key, created_at
            )
            SELECT
              message_id,
              channel_id,
              COALESCE(shard_id, 0)::SMALLINT,
              sender_user_id,
              body,
              seq,
              idempotency_key,
              created_at
            FROM msg.messages_legacy;

            DROP TABLE msg.messages_legacy;
          ELSIF relkind_char IS NULL THEN
            CREATE TABLE msg.messages (
              message_id UUID NOT NULL,
              channel_id UUID NOT NULL,
              shard_id SMALLINT NOT NULL DEFAULT 0,
              sender_user_id UUID NOT NULL,
              body TEXT NOT NULL,
              seq BIGINT NOT NULL,
              idempotency_key TEXT,
              created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
              UNIQUE (shard_id, channel_id, seq)
            ) PARTITION BY HASH (shard_id);
          END IF;
        END $$;
      `);

      for (let shard = 0; shard < this.messageShards; shard += 1) {
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS msg.messages_p${shard}
          PARTITION OF msg.messages
          FOR VALUES WITH (MODULUS ${this.messageShards}, REMAINDER ${shard})
        `);
      }

      await this.pool.query(`
        DO $$
        DECLARE r RECORD;
        BEGIN
          IF to_regclass('msg.messages') IS NOT NULL THEN
            FOR r IN
              SELECT conrelid::regclass AS table_name, conname
              FROM pg_constraint
              WHERE contype = 'f' AND confrelid = 'msg.messages'::regclass
            LOOP
              EXECUTE format('ALTER TABLE %s DROP CONSTRAINT IF EXISTS %I', r.table_name, r.conname);
            END LOOP;
          END IF;
        END $$;
      `);

      await this.pool.query(`DROP INDEX IF EXISTS msg.messages_sender_idempotency_uq`);
      await this.pool.query(`DROP INDEX IF EXISTS msg.messages_sender_channel_idempotency_uq`);
      await this.pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS messages_sender_shard_channel_idempotency_uq
        ON msg.messages (sender_user_id, shard_id, channel_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL
      `);

      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS messages_channel_seq_idx
        ON msg.messages (channel_id, seq DESC)
      `);

      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS messages_shard_channel_seq_idx
        ON msg.messages (shard_id, channel_id, seq DESC)
      `);

      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS messages_message_id_idx
        ON msg.messages (message_id)
      `);

      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS msg.direct_conversations (
          user_a UUID NOT NULL,
          user_b UUID NOT NULL,
          channel_id UUID NOT NULL UNIQUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (user_a, user_b)
        )
      `);

      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS msg.delivery_receipts (
          message_id UUID NOT NULL,
          user_id UUID NOT NULL,
          delivered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (message_id, user_id)
        )
      `);

      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS msg.read_receipts (
          message_id UUID NOT NULL,
          user_id UUID NOT NULL,
          read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (message_id, user_id)
        )
      `);

      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS msg.attachments (
          attachment_id UUID PRIMARY KEY,
          owner_user_id UUID NOT NULL,
          object_key TEXT NOT NULL UNIQUE,
          file_name TEXT NOT NULL,
          content_type TEXT NOT NULL,
          size_bytes BIGINT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending_upload', 'uploaded')),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          uploaded_at TIMESTAMPTZ
        )
      `);

      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS attachments_owner_status_idx
        ON msg.attachments (owner_user_id, status, created_at DESC)
      `);

      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS msg.message_attachments (
          message_id UUID NOT NULL,
          attachment_id UUID NOT NULL REFERENCES msg.attachments(attachment_id) ON DELETE CASCADE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (message_id, attachment_id)
        )
      `);

      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS message_attachments_attachment_idx
        ON msg.message_attachments (attachment_id, created_at DESC)
      `);

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

  private toMessageEntity(
    row: MessageRow,
    requesterUserId?: string,
    attachments: AttachmentEntity[] = []
  ) {
    const deliveredCount = Number(row.delivered_count ?? 0);
    const readCount = Number(row.read_count ?? 0);

    const requesterIsSender = requesterUserId ? requesterUserId === row.sender_user_id : false;
    const delivered = requesterUserId
      ? requesterIsSender
        ? deliveredCount > 0
        : !!row.requester_has_delivered
      : false;
    const read = requesterUserId
      ? requesterIsSender
        ? readCount > 0
        : !!row.requester_has_read
      : false;

    return {
      message_id: row.message_id,
      channel_id: row.channel_id,
      sender_user_id: row.sender_user_id,
      body: row.body,
      seq: Number(row.seq),
      delivered,
      read,
      delivered_count: deliveredCount,
      read_count: readCount,
      attachments,
      created_at:
        row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString()
    };
  }

  private isPgError(error: unknown): error is { code?: string } {
    return typeof error === 'object' && error !== null && 'code' in error;
  }

  private isGrpcError(error: unknown): error is { code?: number } {
    return typeof error === 'object' && error !== null && 'code' in error;
  }

  private computeShardId(channelId: string) {
    let hash = 0;
    const value = channelId || '';
    for (let i = 0; i < value.length; i += 1) {
      hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
    }
    return hash % this.messageShards;
  }
}
