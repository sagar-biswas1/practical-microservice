#!/usr/bin/env bash
# Boots the whole stack for local development: the docker-compose backing
# stores first (waiting until their healthchecks pass), then every workspace
# package's `dev` script in parallel. Ctrl+C stops the services; the containers
# keep running — `pnpm infra:down` stops those.
set -euo pipefail

cd "$(dirname "$0")/.."

if ! docker info >/dev/null 2>&1; then
  echo "Docker is not running. Start Docker Desktop and try again." >&2
  exit 1
fi

port_in_use() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

# compose service -> the host port the app services connect to. If something
# (another project's container, a Homebrew install) already listens there,
# reuse it rather than failing on "port is already allocated".
to_start=()
for entry in redis:6379 rabbitmq:5672; do
  svc="${entry%%:*}"
  port="${entry##*:}"
  if port_in_use "$port" && [ -z "$(docker compose ps -q --status running "$svc")" ]; then
    echo "==> Port $port already in use; reusing the existing $svc instead of starting one."
  else
    to_start+=("$svc")
  fi
done

if [ ${#to_start[@]} -gt 0 ]; then
  echo "==> Starting infrastructure (${to_start[*]})..."
  # --wait blocks until the containers report healthy, so services don't boot
  # into connection-refused errors against a RabbitMQ that is still starting.
  docker compose up -d --wait "${to_start[@]}"
fi

echo "==> Infrastructure ready. RabbitMQ UI: http://localhost:15672 (guest/guest)"
echo "==> Starting all services..."
exec pnpm -r --parallel dev
