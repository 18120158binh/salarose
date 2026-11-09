# How to run the stack locally

Run the full pipeline on one machine with Podman. This guide is for people. Agents must not start services. See the "Verify" section of [AGENTS.md](../../../AGENTS.md).

Prerequisites: Podman with `podman compose`, pnpm, and Java 21.

## Start the stack

1. Build the Flink image. `infra/local/docker-compose.yml` builds it from a `Containerfile` that does not exist, so build it from `event-processor/Dockerfile` and tag it as compose expects:

   ```bash
   podman build -t flink-custom:2.2.0-java21 event-processor
   ```

2. Build the Flink jobs. The JAR lands in `event-processor/target`, which the Flink containers mount.

   ```bash
   pnpm flink:build
   ```

3. Copy `.env.example` to `.env` and set `POSTGRES_PASSWORD`. Copy `studio/.env.example` to `studio/.env.local`. Set `DATABASE_URL` with the same password, and set the `OIDC_*` variables and `SESSION_SECRET` as [configuration](configuration.md#studio) describes. Give your own account at the provider a claim value that `OIDC_ROLE_MAP` maps to `admin`. Your first sign-in creates your staff user. Register `http://localhost:3001/api/auth/oidc/callback` as a redirect URI at the provider. Then start the containers and load the schema.

   ```bash
   pnpm infra:up && pnpm db:reset
   ```

   `init-db.sh` uses `docker`, not `podman`. If you have no `docker` command, alias it to `podman` or run the `psql` commands in the script by hand.

4. Submit the five jobs.

   ```bash
   pnpm flink:submit
   ```

   It submits each consumer before the job that feeds it: the profile writer, state machine, and outbox jobs, then customer decision, then event parse. A new consumer group starts at the latest offset, so a job submitted after its producer misses what the producer already wrote. `flink:profile-writer`, `flink:state-machine`, `flink:outbox`, `flink:decision`, and `flink:parse` submit one job each.

   The compose file sets `KAFKA_EVENT_TOPIC_PATTERN=snowplow-good` on the JobManager, where `flink run` reads the job settings. The job's default pattern does not match the local collector's topic.

   `podman exec -d` returns before the job starts, so check the Flink UI to confirm each job is running.

5. Start the admin app on port 3001.

   ```bash
   pnpm studio:dev
   ```

## Services

| Service | Container | Port | Use |
|---|---|---|---|
| Redpanda (Kafka) | `redpanda-broker` | 9092 and 29092 from the host, `redpanda:29092` inside | Topics |
| Redpanda Console | `redpanda-console` | 8082 | Browse topics and messages |
| OpenSnowcat collector | `opensnowcat-collector` | 8080 | Tracker endpoint |
| Postgres 16 | `postgres-db` | 5432 | Database `auroracy`, user `postgres`, password from `POSTGRES_PASSWORD` in `.env`, `wal_level=logical` for CDC |
| Flink JobManager | `flink-jobmanager` | 8081 | Flink UI |
| Flink TaskManager | `flink-taskmanager` | None | 4 task slots |
| Redis | `redis-profiles` | 6379 | Not used by any code |

`infra/local/vmagent.yml` scrapes services that the compose file does not define. It is not used locally.

`customer_profiles` does not exist locally, so profile conditions never match and notification profiles are empty.

## Stop the stack

```bash
pnpm infra:down
```
