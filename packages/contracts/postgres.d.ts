import { PoolConfig } from 'pg';

export type PostgresSslConfig =
  | {
      rejectUnauthorized: boolean;
    }
  | undefined;

export declare function resolvePostgresSsl(env?: NodeJS.ProcessEnv): PostgresSslConfig;

export declare function createPostgresPoolConfig(defaultDatabase?: string, env?: NodeJS.ProcessEnv): PoolConfig;
