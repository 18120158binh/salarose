#!/bin/bash
set -e

# Get the directory of this script
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
PROJECT_ROOT="$(cd "$DIR/../.." >/dev/null 2>&1 && pwd)"

# Load settings from the repo root .env (see .env.example)
if [ -f "$PROJECT_ROOT/.env" ]; then
  set -a
  . "$PROJECT_ROOT/.env"
  set +a
fi

# If DB_HOST is provided, connect directly (e.g., to AWS RDS PostgreSQL)
if [ -n "$DB_HOST" ]; then
  DB_PORT=${DB_PORT:-5432}
  DB_USER=${DB_USER:-postgres}
  DB_NAME=${DB_NAME:-auroracy}
  : "${DB_PASSWORD:?Set DB_PASSWORD in .env}"
  export PGPASSWORD="$DB_PASSWORD"

  echo "=== Resets Managed PostgreSQL Database at $DB_HOST ==="

  echo "Waiting for database to be ready at $DB_HOST:$DB_PORT..."
  python3 -c "
import socket, sys, time
host = '$DB_HOST'
port = int('$DB_PORT')
while True:
    try:
        with socket.create_connection((host, port), timeout=2):
            print('Database port is open!')
            break
    except OSError:
        time.sleep(2)
"
  echo "Database is ready!"

  echo "Re-applying complete schema (infra/db/schema.sql)..."
  docker run --rm -v "$PROJECT_ROOT:/app" -e PGPASSWORD="$PGPASSWORD" postgres:16-alpine psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -f "/app/infra/db/schema.sql"
else
  # Default to local docker container setup
  CONTAINER_NAME="postgres-db"
  DB_NAME="auroracy"
  DB_USER="postgres"

  echo "=== Resets Local PostgreSQL Database ==="
  if ! docker ps --filter "name=${CONTAINER_NAME}" --filter "status=running" --format "{{.Names}}" | grep -q "^${CONTAINER_NAME}$"; then
    echo "Error: Container '${CONTAINER_NAME}' is not running."
    echo "Please start the infrastructure containers first (e.g., run 'pnpm infra:up')."
    exit 1
  fi

  echo "Re-applying complete schema (infra/db/schema.sql)..."
  docker exec -i "${CONTAINER_NAME}" psql -U "${DB_USER}" -d "${DB_NAME}" < "$PROJECT_ROOT/infra/db/schema.sql"
fi

echo "=== Database reset completed successfully! ==="
