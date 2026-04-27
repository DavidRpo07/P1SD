import { BadRequestException, Inject, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { createPostgresPoolConfig } from '@groupsapp/contracts/postgres';
import { lastValueFrom, Observable } from 'rxjs';

interface AuthUserProfile {
  user_id: string;
  display_name: string;
  email: string;
}

interface AuthGrpcService {
  GetUserById(data: { user_id: string }): Observable<{ found: boolean; user_id: string; display_name: string; email: string }>;
  GetUsersByIds(data: { user_ids: string[] }): Observable<{ items: AuthUserProfile[] }>;
}

@Injectable()
export class UserStoreService implements OnModuleInit, OnModuleDestroy {
  private readonly presenceTtlSeconds = Number(process.env.PRESENCE_TTL_SECONDS || '60');
  private authGrpcService!: AuthGrpcService;

  private readonly pool = new Pool(createPostgresPoolConfig('groupsapp'));

  private readonly redis = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: Number(process.env.REDIS_PORT || '6379'),
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: true
  });

  constructor(@Inject('AUTH_GRPC') private readonly authClient: ClientGrpc) {}

  async onModuleInit() {
    this.authGrpcService = this.authClient.getService<AuthGrpcService>('AuthService');
    await this.redis.connect();
    await this.initSchema();
  }

  async onModuleDestroy() {
    await this.redis.quit();
    await this.pool.end();
  }

  async addContact(ownerUserId: string, contactUserId: string) {
    if (ownerUserId === contactUserId) {
      throw new BadRequestException('CONTACT_SELF_NOT_ALLOWED');
    }

    await this.ensureUserExists(ownerUserId);
    await this.ensureUserExists(contactUserId);

    await this.pool.query(
      `INSERT INTO usr.contacts (owner_user_id, contact_user_id)
       VALUES ($1, $2)
       ON CONFLICT (owner_user_id, contact_user_id) DO NOTHING`,
      [ownerUserId, contactUserId]
    );

    return { ok: true };
  }

  async listContacts(ownerUserId: string) {
    await this.ensureUserExists(ownerUserId);

    const contacts = await this.pool.query<{ contact_user_id: string }>(
      `SELECT c.contact_user_id
       FROM usr.contacts c
       WHERE c.owner_user_id = $1
       ORDER BY c.created_at ASC`,
      [ownerUserId]
    );

    const profiles = await this.fetchUsersByIds(contacts.rows.map((row) => row.contact_user_id));
    const sorted = [...profiles].sort((a, b) => {
      const byName = a.display_name.localeCompare(b.display_name);
      if (byName !== 0) {
        return byName;
      }
      return a.email.localeCompare(b.email);
    });

    return { items: sorted };
  }

  async blockUser(blockerUserId: string, blockedUserId: string) {
    if (blockerUserId === blockedUserId) {
      throw new BadRequestException('BLOCK_SELF_NOT_ALLOWED');
    }

    await this.ensureUserExists(blockerUserId);
    await this.ensureUserExists(blockedUserId);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `INSERT INTO usr.blocks (blocker_user_id, blocked_user_id)
         VALUES ($1, $2)
         ON CONFLICT (blocker_user_id, blocked_user_id) DO NOTHING`,
        [blockerUserId, blockedUserId]
      );

      await client.query(
        `DELETE FROM usr.contacts
         WHERE (owner_user_id = $1 AND contact_user_id = $2)
            OR (owner_user_id = $2 AND contact_user_id = $1)`,
        [blockerUserId, blockedUserId]
      );

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    return { ok: true };
  }

  async checkDirectMessagingPolicy(requesterUserId: string, peerUserId: string) {
    if (requesterUserId === peerUserId) {
      return { allowed: false, reason: 'DM_SELF_NOT_ALLOWED' };
    }

    const requesterExists = await this.userExists(requesterUserId);
    const peerExists = await this.userExists(peerUserId);
    if (!requesterExists || !peerExists) {
      return { allowed: false, reason: 'USER_NOT_FOUND' };
    }

    const blocked = await this.pool.query(
      `SELECT 1
       FROM usr.blocks
       WHERE (blocker_user_id = $1 AND blocked_user_id = $2)
          OR (blocker_user_id = $2 AND blocked_user_id = $1)
       LIMIT 1`,
      [requesterUserId, peerUserId]
    );
    if (blocked.rows.length) {
      return { allowed: false, reason: 'DM_BLOCKED' };
    }

    const inContacts = await this.pool.query(
      `SELECT 1
       FROM usr.contacts
       WHERE (owner_user_id = $1 AND contact_user_id = $2)
          OR (owner_user_id = $2 AND contact_user_id = $1)
       LIMIT 1`,
      [requesterUserId, peerUserId]
    );
    if (!inContacts.rows.length) {
      return { allowed: false, reason: 'DM_CONTACT_REQUIRED' };
    }

    return { allowed: true, reason: 'OK' };
  }

  async setPresence(userId: string, status: string) {
    await this.ensureUserExists(userId);

    const normalized = (status || '').toLowerCase().trim();
    if (normalized !== 'online' && normalized !== 'offline') {
      throw new BadRequestException('PRESENCE_INVALID_STATUS');
    }

    const key = this.presenceKey(userId);
    if (normalized === 'online') {
      await this.redis.set(key, 'online', 'EX', this.presenceTtlSeconds);
    } else {
      await this.redis.del(key);
    }

    return { ok: true };
  }

  async getPresence(userId: string) {
    await this.ensureUserExists(userId);

    const key = this.presenceKey(userId);
    const value = await this.redis.get(key);
    if (!value) {
      return {
        online: false,
        state: 'offline',
        ttl_seconds: 0
      };
    }

    const ttl = await this.redis.ttl(key);
    return {
      online: true,
      state: 'online',
      ttl_seconds: ttl > 0 ? ttl : 0
    };
  }

  private async ensureUserExists(userId: string) {
    const exists = await this.userExists(userId);
    if (!exists) {
      throw new NotFoundException('USER_NOT_FOUND');
    }
  }

  private async userExists(userId: string) {
    const response = await lastValueFrom(this.authGrpcService.GetUserById({ user_id: userId }));
    return !!response.found;
  }

  private async fetchUsersByIds(userIds: string[]) {
    const response = await lastValueFrom(this.authGrpcService.GetUsersByIds({ user_ids: userIds }));
    return response.items || [];
  }

  private async initSchema() {
    await this.pool.query(`CREATE SCHEMA IF NOT EXISTS usr`);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS usr.contacts (
        owner_user_id UUID NOT NULL,
        contact_user_id UUID NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (owner_user_id, contact_user_id)
      )
    `);

    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS contacts_contact_idx
      ON usr.contacts (contact_user_id, owner_user_id)
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS usr.blocks (
        blocker_user_id UUID NOT NULL,
        blocked_user_id UUID NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (blocker_user_id, blocked_user_id)
      )
    `);

    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS blocks_blocked_idx
      ON usr.blocks (blocked_user_id, blocker_user_id)
    `);
  }

  private presenceKey(userId: string) {
    return `presence:user:${userId}`;
  }
}
