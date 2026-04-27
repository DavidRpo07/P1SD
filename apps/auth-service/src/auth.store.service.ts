import { Injectable, OnModuleDestroy, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'crypto';
import * as jwt from 'jsonwebtoken';
import { Pool } from 'pg';
import { createPostgresPoolConfig } from '@groupsapp/contracts/postgres';
import { v7 as uuidv7 } from 'uuid';

interface AuthUser {
  userId: string;
  email: string;
  displayName: string;
  passwordHash: string;
}

@Injectable()
export class AuthStoreService implements OnModuleInit, OnModuleDestroy {
  private readonly pool = new Pool(createPostgresPoolConfig('groupsapp'));

  async onModuleInit() {
    await this.initSchema();
  }

  async onModuleDestroy() {
    await this.pool.end();
  }

  async register(email: string, password: string, displayName: string) {
    const user: AuthUser = {
      userId: uuidv7(),
      email,
      displayName,
      passwordHash: this.hashPassword(password)
    };

    try {
      const inserted = await this.pool.query<{
        user_id: string;
        email: string;
        display_name: string;
      }>(
        `INSERT INTO auth.users (user_id, email, display_name, password_hash)
         VALUES ($1, $2, $3, $4)
         RETURNING user_id, email, display_name`,
        [user.userId, user.email, user.displayName, user.passwordHash]
      );

      return this.toAuthResponse({
        userId: inserted.rows[0].user_id,
        email: inserted.rows[0].email,
        displayName: inserted.rows[0].display_name,
        passwordHash: user.passwordHash
      });
    } catch (error: unknown) {
      if (this.isPgError(error) && error.code === '23505') {
        throw new Error('AUTH_EMAIL_EXISTS');
      }
      throw error;
    }
  }

  async login(email: string, password: string) {
    const found = await this.pool.query<{
      user_id: string;
      email: string;
      display_name: string;
      password_hash: string;
    }>(
      `SELECT user_id, email, display_name, password_hash
       FROM auth.users
       WHERE email = $1
       LIMIT 1`,
      [email]
    );

    if (!found.rows.length) {
      throw new UnauthorizedException('AUTH_INVALID_CREDENTIALS');
    }

    const user = found.rows[0];
    if (user.password_hash !== this.hashPassword(password)) {
      throw new UnauthorizedException('AUTH_INVALID_CREDENTIALS');
    }

    return this.toAuthResponse({
      userId: user.user_id,
      email: user.email,
      displayName: user.display_name,
      passwordHash: user.password_hash
    });
  }

  validateToken(accessToken: string) {
    try {
      const decoded = jwt.verify(accessToken, this.jwtSecret()) as {
        sub: string;
        email: string;
      };

      return {
        valid: true,
        user_id: decoded.sub,
        email: decoded.email
      };
    } catch {
      return {
        valid: false,
        user_id: '',
        email: ''
      };
    }
  }

  async getUserById(userId: string) {
    const found = await this.pool.query<{
      user_id: string;
      email: string;
      display_name: string;
    }>(
      `SELECT user_id, email, display_name
       FROM auth.users
       WHERE user_id = $1
       LIMIT 1`,
      [userId]
    );

    if (!found.rows.length) {
      return {
        found: false,
        user_id: '',
        email: '',
        display_name: ''
      };
    }

    const row = found.rows[0];
    return {
      found: true,
      user_id: row.user_id,
      email: row.email,
      display_name: row.display_name
    };
  }

  async getUsersByIds(userIds: string[]) {
    const ids = Array.from(
      new Set(
        (userIds || [])
          .map((id) => id.trim())
          .filter((id) => id.length > 0)
      )
    );

    if (!ids.length) {
      return { items: [] };
    }

    const found = await this.pool.query<{
      user_id: string;
      email: string;
      display_name: string;
    }>(
      `SELECT user_id, email, display_name
       FROM auth.users
       WHERE user_id = ANY($1::uuid[])`,
      [ids]
    );

    const byId = new Map(
      found.rows.map((row) => [
        row.user_id,
        {
          user_id: row.user_id,
          email: row.email,
          display_name: row.display_name
        }
      ])
    );

    return {
      items: ids
        .map((id) => byId.get(id))
        .filter((item): item is { user_id: string; email: string; display_name: string } => !!item)
    };
  }

  private async initSchema() {
    await this.pool.query(`CREATE SCHEMA IF NOT EXISTS auth`);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS auth.users (
        user_id UUID PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }

  private toAuthResponse(user: AuthUser) {
    const accessToken = jwt.sign(
      {
        sub: user.userId,
        email: user.email
      },
      this.jwtSecret(),
      { expiresIn: '8h' }
    );

    return {
      user_id: user.userId,
      email: user.email,
      display_name: user.displayName,
      access_token: accessToken
    };
  }

  private hashPassword(password: string) {
    return createHash('sha256').update(password).digest('hex');
  }

  private jwtSecret() {
    return process.env.JWT_SECRET || 'super-secret-dev-key';
  }

  private isPgError(error: unknown): error is { code?: string } {
    return typeof error === 'object' && error !== null && 'code' in error;
  }
}
