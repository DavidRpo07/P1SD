function resolvePostgresSsl(env = process.env) {
  if (String(env.POSTGRES_SSL).toLowerCase() !== 'true') {
    return undefined;
  }

  return {
    rejectUnauthorized: String(env.POSTGRES_SSL_REJECT_UNAUTHORIZED).toLowerCase() === 'true'
  };
}

function createPostgresPoolConfig(defaultDatabase = 'groupsapp', env = process.env) {
  const ssl = resolvePostgresSsl(env);

  return {
    host: env.POSTGRES_HOST || 'localhost',
    port: Number(env.POSTGRES_PORT || '5432'),
    user: env.POSTGRES_USER || 'groupsapp',
    password: env.POSTGRES_PASSWORD || 'groupsapp',
    database: env.POSTGRES_DB || defaultDatabase,
    ssl
  };
}

module.exports = {
  createPostgresPoolConfig,
  resolvePostgresSsl
};
