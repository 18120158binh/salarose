# Runtime checklist

What a target must have before the Flink jobs and `studio` start. [Configuration](../../../../docs/internal/operations/configuration.md) names every variable and default. [The data model](../../../../docs/internal/architecture/data-model.md) lists the tables and the CDC publications.

## Postgres

| Item | Check | Notes |
|---|---|---|
| Version 16, logical WAL | `SHOW wal_level;` returns `logical` | Managed Postgres needs a parameter for this. On RDS: `rds.logical_replication = 1`, then a reboot. |
| Database `auroracy` | `\l` | Or set `DB_DATABASE` |
| Schema | `\dt` lists `campaigns`, `campaign_nodes`, `user_metric_definitions`, `user_metrics`, `identity_graph`, `user_campaign_state_transitions` | The Job `db-migrate` creates them from `infra/db/migrations/`, as the role in `DB_USER`. `SELECT version, success FROM flyway_schema_history ORDER BY installed_rank;` shows the applied versions. Never run `schema.sql` on a database with data, because it drops and recreates tables. |
| Publications | `SELECT pubname FROM pg_publication;` lists `campaigns_pub`, `campaign_nodes_pub`, `metric_defs_pub`, `outbox_transitions_pub` | Created by the migrations, owned by `DB_USER` |
| Heartbeat table | `SELECT pubname FROM pg_publication_tables WHERE tablename = 'cdc_heartbeat';` lists every publication above, and `DB_USER` can insert and update `cdc_heartbeat` | Every CDC source writes its slot's row there every 30 seconds. A source that cannot write it fails. |
| Replication rights | The `DB_USER` role can create replication slots | On RDS: `GRANT rds_replication TO <user>;` |
| Free slots | `max_replication_slots` and `max_wal_senders` are each at least 16, plus any other consumers | The jobs keep 8 slots. Their names are in the data model. On a start without saved state, each of the 8 CDC sources also opens one temporary slot and WAL sender while it reads its snapshot. |
| Staff roles | The provider gives at least one person a claim value that `OIDC_ROLE_MAP` maps to `admin` | Studio creates each staff user at their first sign-in, with the role from the provider's ID token. Nobody is created by hand. |
| `customer_profiles` | Exists, or the user accepts empty profiles | Another system owns it. Without it, profile conditions never match. |

The Flink jobs connect to `DB_HOST` for writes, CDC, and identity lookups, and to `DB_READ_HOST` for metric and profile lookups. `DB_HOST` must be the primary, never a replica.

## Kafka

Create these topics before the jobs start if the broker does not create topics on first use. Amazon MSK does not by default.

| Topic | Key | Partitions |
|---|---|---|
| `snowplow-good`, `snowplow-bad` | None | Match the collector's throughput |
| `snowplow-parsed` | `canon_id` | At least the decision job's parallelism |
| `snowplow-parsed-dead-letters` | None | 1 to 3. Set `retention.ms` and restrict access: it holds raw payloads with personal data. |
| `customer-profile-mutations` | `canon_id` | At least the profile writer's parallelism |
| `journey-engine-matched-events` | Journey key | At least the state machine's parallelism |
| `journey-engine-segment-checks` | `canon_id` | At least the decision job's parallelism |
| `journey-engine-outbound-noti` | None | Match the sender |

Create `journey-engine-segment-checks` before customer decision starts, even on a broker that creates topics on first use. Customer decision reads it before the state machine writes to it, and the Kafka source never creates a topic, so a missing one fails the job with `Failed to get metadata for topics`.

`EventParseJob` subscribes by the regex in `KAFKA_EVENT_TOPIC_PATTERN`. Its default does not match `snowplow-good`. Set it on every target.

Kafka security comes from `<PREFIX>_KAFKA_SECURITY_PROTOCOL`, `_SASL_MECHANISM`, `_SASL_JAAS_CONFIG`, and the truststore variables. The JAR supports `PLAINTEXT`, `SSL`, `SASL_SSL` with SCRAM, and PLAIN. It does not bundle a library for MSK IAM authentication.

## Flink

| Item | Value |
|---|---|
| Image | Flink `2.2.0-java21` with the Postgres driver and the other JARs from `event-processor/Dockerfile`. The connectors ship in the job JAR. |
| Job JAR | `event-processor-1.0.0-SNAPSHOT.jar`, from the build. Pin the versioned copy. |
| State backend | RocksDB. Heap state is not allowed for the decision job (DEC-NFR-07). |
| Checkpoints and savepoints | Durable storage that outlives the cluster: S3 or a persistent volume |
| Task slots | At least the sum of the five jobs' parallelism |
| Metrics reporter | [infra/monitoring/flink-prometheus-reporter.yaml](../../../../infra/monitoring/flink-prometheus-reporter.yaml) applied to the Flink configuration in the Argo CD repo. Check that `lateMatchedEvents` and `invalidMatchedEvents` reach Prometheus. |
| Alert rules | [infra/monitoring/journey-engine-alerts.yaml](../../../../infra/monitoring/journey-engine-alerts.yaml) applied to Prometheus in the Argo CD repo. Without them, triggers dropped as late (JEX-NFR-08) alert no one. |

## studio

| Variable | Rule |
|---|---|
| `DATABASE_URL` | Required |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID` | Required |
| `OIDC_ROLE_CLAIM`, `OIDC_ROLE_MAP` | Required. Without them every sign-in fails with `server_error`. |
| `OIDC_CLIENT_SECRET`, `SESSION_SECRET` | Required. Store them in the target's secret store, never in a manifest or an image. |
| `OIDC_REDIRECT_URL` | The public HTTPS URL plus `/api/auth/oidc/callback`. Register it at the provider exactly. |
| `OPENAI_API_KEY`, `OPENAI_API_BASE`, `LLM_MODEL` | Only for AI journey generation |

The container listens on port `3000`. TLS ends at the load balancer or the ingress.

## Collector

[Onboard a customer](../../../../docs/internal/operations/onboard-a-customer.md#collector-in-production) lists the production changes: a subdomain on the customer's domain, TLS, the cookie domain, the brokers, and CORS.

The OpenSnowcat collector writes tracker hits to `snowplow-good`. Deploy it with `infra/local/collector.config`, pointed at the target's brokers. Trackers need its public URL.
