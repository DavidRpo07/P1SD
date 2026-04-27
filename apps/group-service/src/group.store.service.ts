import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit
} from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { Pool } from 'pg';
import { createPostgresPoolConfig } from '@groupsapp/contracts/postgres';
import { lastValueFrom, Observable } from 'rxjs';
import { v7 as uuidv7 } from 'uuid';

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
export class GroupStoreService implements OnModuleInit, OnModuleDestroy {
  private authGrpcService!: AuthGrpcService;

  private readonly pool = new Pool(createPostgresPoolConfig('groupsapp'));

  constructor(@Inject('AUTH_GRPC') private readonly authClient: ClientGrpc) {}

  async onModuleInit() {
    this.authGrpcService = this.authClient.getService<AuthGrpcService>('AuthService');
    await this.initSchema();
  }

  async onModuleDestroy() {
    await this.pool.end();
  }

  async createGroup(name: string, description: string, ownerUserId: string) {
    const groupId = uuidv7();
    const normalizedName = (name || '').trim();
    if (!normalizedName) {
      throw new BadRequestException('GROUP_NAME_REQUIRED');
    }

    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO grp.groups (group_id, name, description, owner_user_id)
         VALUES ($1, $2, $3, $4)`,
        [groupId, normalizedName, description || '', ownerUserId]
      );

      await client.query(
        `INSERT INTO grp.group_members (group_id, user_id, is_admin)
         VALUES ($1, $2, true)`,
        [groupId, ownerUserId]
      );

      await client.query(
        `INSERT INTO grp.channels (channel_id, group_id, name, description, is_default, created_by_user_id)
         VALUES ($1, $1, 'general', 'Canal general por defecto', true, $2)`,
        [groupId, ownerUserId]
      );

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    return {
      group_id: groupId,
      name: normalizedName,
      description: description || '',
      owner_user_id: ownerUserId
    };
  }

  async listMyGroups(userId: string) {
    const groups = await this.pool.query<{
      group_id: string;
      name: string;
      description: string;
      owner_user_id: string;
    }>(
      `SELECT g.group_id, g.name, g.description, g.owner_user_id
       FROM grp.group_members gm
       JOIN grp.groups g ON g.group_id = gm.group_id
       WHERE gm.user_id = $1
       ORDER BY g.created_at DESC`,
      [userId]
    );

    return { items: groups.rows };
  }

  async addMember(groupId: string, requesterUserId: string, memberUserId: string) {
    await this.ensureGroupExists(groupId);
    await this.ensureGroupAdmin(groupId, requesterUserId);
    await this.ensureUserExists(memberUserId);

    await this.pool.query(
      `INSERT INTO grp.group_members (group_id, user_id, is_admin)
       VALUES ($1, $2, false)
       ON CONFLICT (group_id, user_id) DO NOTHING`,
      [groupId, memberUserId]
    );

    return { ok: true };
  }

  async removeMember(groupId: string, requesterUserId: string, memberUserId: string) {
    const group = await this.pool.query<{ owner_user_id: string }>(
      `SELECT owner_user_id
       FROM grp.groups
       WHERE group_id = $1
       LIMIT 1`,
      [groupId]
    );

    if (!group.rows.length) {
      throw new NotFoundException('GROUP_NOT_FOUND');
    }

    await this.ensureGroupAdmin(groupId, requesterUserId);

    if (group.rows[0].owner_user_id === memberUserId) {
      throw new ForbiddenException('GROUP_OWNER_CANNOT_BE_REMOVED');
    }

    await this.pool.query(
      `DELETE FROM grp.group_members
       WHERE group_id = $1 AND user_id = $2`,
      [groupId, memberUserId]
    );

    return { ok: true };
  }

  async listGroupMembers(groupId: string, requesterUserId: string) {
    await this.ensureGroupExists(groupId);

    const isMember = await this.isGroupMember(groupId, requesterUserId);
    if (!isMember) {
      throw new ForbiddenException('GROUP_FORBIDDEN');
    }

    const members = await this.pool.query<{ user_id: string; is_admin: boolean }>(
      `SELECT gm.user_id, gm.is_admin
       FROM grp.group_members gm
       WHERE gm.group_id = $1
       ORDER BY gm.is_admin DESC, gm.created_at ASC`,
      [groupId]
    );

    const profiles = await this.fetchUsersByIds(members.rows.map((row) => row.user_id));
    const profileById = new Map(profiles.map((profile) => [profile.user_id, profile]));

    const items = members.rows
      .map((row) => {
        const profile = profileById.get(row.user_id);
        if (!profile) {
          return null;
        }
        return {
          user_id: row.user_id,
          display_name: profile.display_name,
          email: profile.email,
          is_admin: row.is_admin
        };
      })
      .filter(
        (
          item
        ): item is {
          user_id: string;
          display_name: string;
          email: string;
          is_admin: boolean;
        } => !!item
      );

    return { items };
  }

  async checkMembership(groupId: string, userId: string) {
    const isMember = await this.isGroupMember(groupId, userId);
    return { is_member: isMember };
  }

  async createChannel(groupId: string, requesterUserId: string, name: string, description: string) {
    await this.ensureGroupExists(groupId);
    await this.ensureGroupAdmin(groupId, requesterUserId);

    const normalizedName = (name || '').trim();
    if (!normalizedName) {
      throw new BadRequestException('CHANNEL_NAME_REQUIRED');
    }

    const channelId = uuidv7();

    try {
      await this.pool.query(
        `INSERT INTO grp.channels (
          channel_id, group_id, name, description, is_default, created_by_user_id
        ) VALUES ($1, $2, $3, $4, false, $5)`,
        [channelId, groupId, normalizedName, description || '', requesterUserId]
      );
    } catch (error) {
      if (this.isPgError(error) && error.code === '23505') {
        throw new ConflictException('CHANNEL_NAME_EXISTS');
      }
      throw error;
    }

    return {
      channel_id: channelId,
      group_id: groupId,
      name: normalizedName,
      description: description || ''
    };
  }

  async listGroupChannels(groupId: string, requesterUserId: string) {
    await this.ensureGroupExists(groupId);

    const isMember = await this.isGroupMember(groupId, requesterUserId);
    if (!isMember) {
      throw new ForbiddenException('GROUP_FORBIDDEN');
    }

    const channels = await this.pool.query<{
      channel_id: string;
      group_id: string;
      name: string;
      description: string;
      is_default: boolean;
    }>(
      `SELECT channel_id, group_id, name, description, is_default
       FROM grp.channels
       WHERE group_id = $1
       ORDER BY is_default DESC, created_at ASC`,
      [groupId]
    );

    return { items: channels.rows };
  }

  async checkChannelMembership(channelId: string, userId: string) {
    const channel = await this.pool.query<{ group_id: string }>(
      `SELECT group_id
       FROM grp.channels
       WHERE channel_id = $1
       LIMIT 1`,
      [channelId]
    );

    if (!channel.rows.length) {
      throw new NotFoundException('CHANNEL_NOT_FOUND');
    }

    const groupId = channel.rows[0].group_id;
    const isMember = await this.isGroupMember(groupId, userId);

    return {
      is_member: isMember,
      group_id: groupId
    };
  }

  private async initSchema() {
    await this.pool.query(`CREATE SCHEMA IF NOT EXISTS grp`);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS grp.groups (
        group_id UUID PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        owner_user_id UUID NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS grp.group_members (
        group_id UUID NOT NULL REFERENCES grp.groups(group_id) ON DELETE CASCADE,
        user_id UUID NOT NULL,
        is_admin BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (group_id, user_id)
      )
    `);

    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS group_members_admin_idx
      ON grp.group_members (group_id, is_admin)
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS grp.channels (
        channel_id UUID PRIMARY KEY,
        group_id UUID NOT NULL REFERENCES grp.groups(group_id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        is_default BOOLEAN NOT NULL DEFAULT false,
        created_by_user_id UUID NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS channels_group_idx
      ON grp.channels (group_id, created_at)
    `);

    await this.pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS channels_group_name_unique
      ON grp.channels (group_id, LOWER(name))
    `);

    await this.pool.query(`
      INSERT INTO grp.channels (channel_id, group_id, name, description, is_default, created_by_user_id)
      SELECT g.group_id, g.group_id, 'general', 'Canal general por defecto', true, g.owner_user_id
      FROM grp.groups g
      WHERE NOT EXISTS (
        SELECT 1 FROM grp.channels c WHERE c.channel_id = g.group_id
      )
    `);
  }

  private async ensureGroupExists(groupId: string) {
    const groupExists = await this.pool.query(
      `SELECT 1 FROM grp.groups WHERE group_id = $1 LIMIT 1`,
      [groupId]
    );
    if (!groupExists.rows.length) {
      throw new NotFoundException('GROUP_NOT_FOUND');
    }
  }

  private async ensureGroupAdmin(groupId: string, requesterUserId: string) {
    const isAdmin = await this.pool.query(
      `SELECT 1
       FROM grp.group_members
       WHERE group_id = $1 AND user_id = $2 AND is_admin = true
       LIMIT 1`,
      [groupId, requesterUserId]
    );

    if (!isAdmin.rows.length) {
      throw new ForbiddenException('GROUP_FORBIDDEN');
    }
  }

  private async isGroupMember(groupId: string, userId: string) {
    const member = await this.pool.query(
      `SELECT 1
       FROM grp.group_members
       WHERE group_id = $1 AND user_id = $2
       LIMIT 1`,
      [groupId, userId]
    );

    return !!member.rows.length;
  }

  private async ensureUserExists(userId: string) {
    const response = await lastValueFrom(this.authGrpcService.GetUserById({ user_id: userId }));
    if (!response.found) {
      throw new NotFoundException('USER_NOT_FOUND');
    }
  }

  private async fetchUsersByIds(userIds: string[]) {
    const response = await lastValueFrom(this.authGrpcService.GetUsersByIds({ user_ids: userIds }));
    return response.items || [];
  }

  private isPgError(error: unknown): error is { code?: string } {
    return typeof error === 'object' && error !== null && 'code' in error;
  }
}
