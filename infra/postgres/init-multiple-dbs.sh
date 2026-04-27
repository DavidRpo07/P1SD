#!/bin/sh
set -eu

if [ -z "${POSTGRES_MULTIPLE_DATABASES:-}" ]; then
  exit 0
fi

echo "Creating additional databases: ${POSTGRES_MULTIPLE_DATABASES}"

for db in $(echo "$POSTGRES_MULTIPLE_DATABASES" | tr ',' ' '); do
  db_trimmed="$(echo "$db" | xargs)"
  if [ -z "$db_trimmed" ]; then
    continue
  fi

  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    SELECT 'CREATE DATABASE "$db_trimmed"'
    WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '$db_trimmed')\gexec
EOSQL
done
