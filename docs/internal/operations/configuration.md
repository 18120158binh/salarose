# Configuration

Every setting that the Flink jobs and `studio` read, with its default. The feature contracts give the bounds in plain terms. This page names the variable that changes each one. [.env.example](../../../.env.example) and [studio/.env.example](../../../studio/.env.example) list the variables for a local run.

## All Flink jobs

| Variable | Default | Effect |
|---|---|---|
| `KAFKA_BROKERS` | `redpanda:29092` | Brokers for every job, unless the job's own variable is set |
| `KAFKA_GROUP_ID` | Per job | Consumer group, unless the job's own variable is set |
| `CHECKPOINT_INTERVAL` | `30s`, `60s` for the outbox | Checkpoint interval. The profile writer does not read it. The CDC restore window is `CDC_CONFIRM_DELAY_CHECKPOINTS` completed checkpoints, so this interval sets how long it lasts. Customer decision takes any duration above 0, such as `500ms`, `30s`, `5m`, `1h`, or `1d`, and a bare number as milliseconds. |
| `DB_HOST` | `postgres` | Writes, CDC, and identity lookups |
| `DB_READ_HOST` | `DB_HOST` | Lookups: metrics, profiles. Event ingestion does not read it. |
| `DB_PORT` | `5432` | |
| `DB_DATABASE` | `auroracy` | |
| `DB_USER` | `postgres` | |
| `DB_PASSWORD` | None. A job fails at start without it. | |
| `CDC_CONFIRM_DELAY_CHECKPOINTS` | `10` | How many completed checkpoints back each CDC source confirms a log position to its slot. This count sets the CDC restore window ([JEX-NFR-10](../architecture/components/journey-execution.md#non-functional-requirements)). A slot holds the WAL of this many checkpoint intervals, so keep the count times the interval times the peak WAL rate under `max_slot_wal_keep_size` ([deployment](deployment.md#rolling-back-to-an-older-savepoint)). A value that is not a whole number above 0 stops the job at start. |

Each job reads the `DB_` variables and `CDC_CONFIRM_DELAY_CHECKPOINTS` once, where it is submitted, and carries them to its task managers. The task managers do not need them. Where the job is submitted depends on the deployment: in application mode it is the job manager, and with `flink run` it is the shell that runs the command.

Each job also reads Kafka security settings with its own prefix: `<PREFIX>_KAFKA_SECURITY_PROTOCOL`, `_SASL_MECHANISM`, `_SASL_JAAS_CONFIG`, `_SSL_TRUSTSTORE_LOCATION`, and `_SSL_TRUSTSTORE_TYPE`. The prefixes are `EVENT_PARSE_SOURCE`, `EVENT_PARSE_SINK`, `CUSTOMER_DECISION`, `PROFILE_WRITER`, `STATE_MACHINE`, `CAMPAIGN_OUTBOX`, and `CAMPAIGN_TIMER`. A missing or empty prefixed variable falls back to the same name without the prefix. An empty protocol means plaintext. `SASL_*` protocols require the JAAS config. The SASL mechanism defaults to `SCRAM-SHA-512` and the truststore type to `PEM`. The jobs pass the JAAS config to the Kafka client unchanged, so it names the client's own login module, such as `org.apache.kafka.common.security.scram.ScramLoginModule`. The job JAR carries that module. The relocated `org.apache.flink.kafka.shaded...` name does not load.

## Event ingestion

| Variable | Default | Effect |
|---|---|---|
| `EVENT_PARSE_SOURCE_KAFKA_BROKERS`, `EVENT_PARSE_SINK_KAFKA_BROKERS` | `KAFKA_BROKERS` | Brokers per side |
| `EVENT_PARSE_SOURCE_GROUP_ID` | `KAFKA_GROUP_ID`, then `event-processor-group` | Consumer group. A new group starts at the latest offset. |
| `KAFKA_EVENT_TOPIC_PATTERN` | `snowplow\.good\.events\..*` | Source topic regex. The local compose file sets `snowplow-good`. Set it on every other target whose collector writes there. |
| `KAFKA_INGESTION_API_TOPIC` | `ingestion-api-events` | Topic of the person events the data ingestion API accepted. Read with the `EVENT_PARSE_SOURCE_` brokers, security settings, and group, committed messages only. A new group starts at the earliest offset. Create it before the job starts: the job fails while it is missing. Studio reads the same variable to write there. |
| `KAFKA_EVENT_PARSED_TOPIC` | `snowplow-parsed` | Output topic |
| `EVENT_PARSE_DEAD_LETTER_PAYLOAD_LIMIT` | `524288` (512 KiB) | Most bytes of a collector payload that a dead letter keeps. A longer payload is cut and flagged `payload_truncated`. Keep it below three quarters of the producer's `max.request.size`, 1 MiB by default, because Base64 grows it by a third. A value that is not a positive integer stops the job from starting. Read where the job is submitted. Chosen during the fix, pending owner review. |
| `KAFKA_EVENT_DEAD_LETTER_TOPIC` | `snowplow-parsed-dead-letters` | Dead-letter topic for every dropped payload and event. Written with the `EVENT_PARSE_SINK_` brokers and security settings. Create it before the job starts: the job fails while it cannot write there. Studio reads the same variable to find the topic. |
| `SNOWPLOW_LEGACY_CONTEXT_SCHEMA_PREFIX` | `iglu:com.example.snowplow/` | Vendor prefix of legacy contexts. Set it to your tracker's vendor. A value that does not start with `iglu:` and end with `/` stops the job from starting. Unset or blank gives the default. Read where the job is submitted. |
| `EVENT_PARSE_PLACEHOLDER_IDS` | `unknown,undefined,null` | Comma-separated values that trackers send in place of a missing id. A `user_id` or `domain_userid` equal to one, after trimming and ignoring case, becomes null before identity stitching, and an `app_id` equal to one gets the default `auroracy-ecommerce`. The list replaces the default, so keep `undefined` in it to keep treating that value as absent. Unset or blank gives the default. An empty entry, such as a trailing comma, stops the job from starting. Read where the job is submitted. |
| `JDBC_BATCH_SIZE`, `JDBC_BATCH_INTERVAL` | `200`, `200ms` | `identity_graph` sink flush. `JDBC_BATCH_SIZE` also sizes the `event_volume` batches. Read where the job is submitted. |
| `EVENT_VOLUME_BATCH_INTERVAL` | `10s` | `event_volume` sink flush. A batch writes each row's latest total once, so a longer interval writes fewer rows and less WAL, and the Data pages lag by up to this much. Read where the job is submitted. |
| `IDENTITY_LOOKUP_TIMEOUT` | `1s`, at least `250ms` | Longest an `identity_graph` lookup waits for a connection, and again for the read. A read past it counts as failed. The event then gets a `canon_id` from state, and the job stores none of it. A value below `250ms` makes the connection pool throw when the stitcher opens. The job then fails at start, and Flink restarts it again and again under its restart strategy. |
| `IDENTITY_LOOKUP_CONCURRENCY` | `4`, a whole number from `1` to `32` | Connections in each stitcher subtask's lookup pool, and threads that run `identity_graph` reads off the stream's thread. The primary gets this many connections per subtask. Unset or blank gives the default. Any other value outside the range stops the job at startup with the variable's name. |
| `IDENTITY_RECHECK_INTERVAL` | `1m` | How long a device whose set holds a `user_id` trusts its state before it reads the user's `identity_graph` rows again. A merge on another device reaches it within this interval plus one sink batch. A shorter interval adds reads: about one per active logged-in device per interval. Read where the job is submitted. |

The stitcher's state TTL is 7 days and its set limit is 200 entries, both fixed in code.

## Customer decision

| Variable | Default | Effect |
|---|---|---|
| `CUSTOMER_DECISION_KAFKA_BROKERS` | `KAFKA_BROKERS` | Brokers |
| `CUSTOMER_DECISION_GROUP_ID` | `KAFKA_GROUP_ID`, then `customer-decision-events` | Consumer group of both inputs. A new group starts at the latest offset of the event topic and the earliest offset of the segment check topic. |
| `KAFKA_EVENT_PARSED_TOPIC` | `snowplow-parsed` | Input |
| `KAFKA_SEGMENT_CHECK_TOPIC` | `journey-engine-segment-checks` | Segment check input. Set the same value on the state machine. |
| `KAFKA_PROFILE_MUTATION_TOPIC` | `customer-profile-mutations` | Mutation output |
| `KAFKA_CAMPAIGN_MATCHED_TOPIC` | `journey-engine-matched-events` | Trigger output |
| `USER_METRICS_STATE_RETENTION_DAYS` | `31` | Days after its last write that a person's metric state, behavior version, and remembered event ids expire |
| `USER_METRICS_MAX_OUT_OF_ORDERNESS_MS` | `600000` | Extra retention for late events. `0` is allowed. |
| `USER_METRICS_MAX_METRICS_PER_CUSTOMER` | `128` | Metrics kept per person |
| `USER_METRICS_MAX_STRING_VALUE_BYTES` | `4096` | Longest string value stored |
| `USER_METRICS_MAX_EVENT_CONTEXT_BYTES` | `32768` | Largest `event_json` accepted |
| `USER_METRICS_READ_TIMEOUT` | `5s`, at least `250ms` | Longest a `user_metrics` read waits for a connection, and again for its result. The job reads a series missing from state and the person's highest behavior version this way. A read past it has failed: the job fails the event and restarts from the last checkpoint. A value below `250ms` counts as `250ms`. A bare number is milliseconds. A value that is not a duration fails the job when the operator opens, and Flink restarts it again and again under its restart strategy. |
| `CAMPAIGN_LOOKUP_TIMEOUT_MS` | `30000` | Timeout of a profile lookup. A lookup past it uses an empty profile. A person's later triggers wait until their lookup ends. |
| `CAMPAIGN_LOOKUP_CAPACITY` | `1000` | Events waiting for a profile, per subtask |
| `PROFILE_LOOKUP_THREADS` | `10` | Profile lookups that run at once per subtask. Each holds its own Postgres connection. |
| `PROFILE_CACHE_MAX_ENTRIES` | `5000`, from 1 to 20000 | Found profiles cached per subtask. An entry holds the fields that one lookup read of one profile. |
| `PROFILE_CACHE_TTL_MINUTES` | `5`, from 1 to 60 | How long a found profile is cached. A failed lookup, or one that finds no profile, is not cached. |

Every number above is a whole number above 0 unless its row says otherwise. A value the job cannot use fails the job when it starts, and the message names the variable. An unset or blank variable takes its default.

The job keeps its state in RocksDB and sets that itself. A `state.backend.type` in the cluster configuration does not change it.

## Profile writer

| Variable | Default | Effect |
|---|---|---|
| `PROFILE_WRITER_KAFKA_BROKERS` | `KAFKA_BROKERS` | Brokers |
| `PROFILE_WRITER_GROUP_ID` | `KAFKA_GROUP_ID`, then `customer-profile-writer` | Consumer group. Without a checkpoint to restore, the job starts at the earliest offset, even for a group with committed offsets. |
| `KAFKA_PROFILE_MUTATION_TOPIC` | `customer-profile-mutations` | Input |

The checkpoint interval is fixed at 30 seconds. The JDBC sink batches 100 rows or 500 ms and retries 3 times.

## Journey execution

| Variable | Default | Effect |
|---|---|---|
| `STATE_MACHINE_KAFKA_BROKERS` | `KAFKA_BROKERS` | Brokers |
| `STATE_MACHINE_GROUP_ID` | `KAFKA_GROUP_ID`, then `campaign-state-machine-group` | Consumer group. A new group starts at the earliest offset. |
| `KAFKA_CAMPAIGN_MATCHED_TOPIC` | `journey-engine-matched-events` | Input |
| `KAFKA_SEGMENT_CHECK_TOPIC` | `journey-engine-segment-checks` | Segment check output. Set the same value on customer decision. |
| `STATE_MACHINE_MAX_OUT_OF_ORDERNESS_MS` | 10 minutes | Watermark delay, rounded down to whole seconds, at least 1 second |
| `STATE_MACHINE_SOURCE_IDLE_TIMEOUT_MS` | `60000` | Idle source timeout. A trigger partition with no trigger for this long stops holding back the watermark. When every partition is idle, the watermark holds. |
| `STATE_MACHINE_MAX_PENDING_MATCHES_PER_JOURNEY` | `1000` | Buffer limit by count, for each entry. Triggers that name no entry share one more limit. |
| `STATE_MACHINE_MAX_PENDING_BYTES_PER_JOURNEY` | 4 MiB | Buffer limit by size, counted the same way |
| `STATE_MACHINE_JOURNEY_STATE_TTL_MS` | 90 days | State TTL, reset on read and write |
| `STATE_MACHINE_GRAPH_LOAD_ALLOWANCE_MS` | 5 minutes | How long, in event time, a trigger whose node or a node above it is missing keeps waiting for its campaign's rows after the watermark passes it. Then it is dropped as unreachable. After a start, the trigger also waits until the allowance has run in real time since the first record, because a trigger backlog moves the watermark faster than real time while the `campaign_nodes` snapshot loads. A campaign save reaches the engine in seconds, and live triggers already wait the out-of-orderness before the allowance starts, so 5 minutes leaves a wide margin. Raise it if the snapshot takes longer than that. |
| `CHECKPOINT_MIN_PAUSE` | `10s` | Minimum pause between checkpoints |

Each numeric `STATE_MACHINE_` setting must be a whole number above 0. An unset or blank variable takes its default. Any other value, such as `0`, `-1`, or `10m`, stops the state machine at startup with an error that names the variable. `STATE_MACHINE_MAX_PENDING_MATCHES_PER_JOURNEY` must also be at most 2147483647.

## Notification outbox

| Variable | Default | Effect |
|---|---|---|
| `ENABLE_OUTBOX`, `ENABLE_TIMER` | `true`, `true` | Turn each flow of the outbox job on or off. Any value other than `true` turns the flow off. |
| `CAMPAIGN_OUTBOX_KAFKA_BROKERS` | `KAFKA_BROKERS` | Brokers |
| `KAFKA_NOTIFICATION_TOPIC` | `journey-engine-outbound-noti` | Output topic |
| `CAMPAIGN_TIMER_KAFKA_BROKERS` | `KAFKA_BROKERS` | Brokers for the timer flow's output |
| `KAFKA_CAMPAIGN_MATCHED_TOPIC` | `journey-engine-matched-events` | Timer flow output |

The profile lookup uses `DB_READ_HOST` with a pool of 5 connections and does not block the stream. It allows 100 lookups in flight, caches 5000 profiles for 5 minutes, and gives up after 10 seconds. A request whose lookup gives up goes out with an empty profile. These values are fixed.

## studio

| Variable | Required | Example | Rules |
|---|---|---|---|
| `DATABASE_URL` | Yes | `postgres://postgres:<password>@localhost:5432/auroracy` | No default |
| `OIDC_ISSUER` | Yes, without `OIDC_PROVIDERS` | `https://keycloak.example.com/realms/cdp` | Absolute URL. `https:` in production. The ID token's `iss` must equal the discovered issuer. |
| `OIDC_CLIENT_ID` | Yes, without `OIDC_PROVIDERS` | `studio` | Non-empty |
| `OIDC_CLIENT_SECRET` | Yes, without `OIDC_PROVIDERS` | (secret) | Non-empty. Sent as `client_secret_post`. |
| `OIDC_REDIRECT_URL` | Yes | `http://localhost:3001/api/auth/oidc/callback` | Absolute URL with the path `/api/auth/oidc/callback`. Register it at the provider exactly. In a deployment, use the ingress's public hostname. Its origin is also the base of every absolute redirect the app sends. An `https:` URL marks the session cookie `Secure`. Every provider shares it. |
| `OIDC_SCOPES` | No | `openid email profile` | Space-separated. Must include `openid` and `email`. |
| `OIDC_NAME` | No | `SSO` | The login page's button reads **Sign in with** and this name. Default `SSO`. |
| `OIDC_ROLE_CLAIM` | Yes | `roles` | The ID token claim that holds the user's roles or groups at the provider. One top-level claim name without spaces. Its value is one string or a list of strings. A sign-in whose claim has no value in `OIDC_ROLE_MAP` fails with `not_authorized`. Missing or invalid, every sign-in fails with `server_error`. |
| `OIDC_ROLE_MAP` | Yes | `{"studio-admin":"admin","studio-editor":"editor"}` | A JSON object from claim values to the Studio roles `admin` and `editor`, compared exactly. At least one entry. When several of a user's values map, the highest role wins: `admin`, then `editor`. Any other role, including `viewer`, is rejected, so viewers cannot sign in. Missing or invalid, every sign-in fails with `server_error`. Quote it in single quotes in a `.env` file or a shell. |
| `OIDC_LOGOUT_ID_TOKEN_HINT` | No | `false` | `true` or `false`, in any case. Default `false`. `true` keeps the ID token of each user's latest sign-in in `system_user_id_tokens`, and **Logout** sends it as `id_token_hint`. Set `true` only for a provider that refuses the sign-out without it, such as Okta. |
| `OIDC_PROVIDERS` | No | `keycloak,entra` | Comma-separated provider ids. Each id is a letter followed by letters and digits, in any case, and read in lower case. Set it to offer more than one provider. Each provider then reads the settings above from `OIDC_<ID>_ISSUER`, `OIDC_<ID>_CLIENT_ID`, and so on, with the id in upper case, and the unprefixed forms must stay unset. See [Several providers](#several-providers). |
| `SESSION_SECRET` | Yes | Output of `openssl rand -base64 32` | At least 32 characters. Changing it signs everyone out. |
| `SESSION_MAX_AGE_SECONDS` | No | `43200` | Integer from 300 to 604800. Default 43200. |
| `OPENAI_API_KEY`, `OPENAI_API_BASE`, `LLM_MODEL` | For AI generation | | All three must be set, or the route returns an error. |
| `AI_GENERATION_LIMIT_PER_MINUTE` | No | `10` | Integer from 1 to 10000. Default 10. AI generation requests one user may send in any 60 seconds, counted per app process. An invalid value makes the route return `503`. |
| `AI_GENERATION_LIMIT_PER_DAY` | No | `100` | Integer from 1 to 10000. Default 100. AI generation requests one user may send in any 24 hours, counted per app process. An invalid value makes the route return `503`. |
| `INGESTION_KAFKA_BROKERS` | For the data ingestion API | `kafka-0:9092,kafka-1:9092` | Comma-separated brokers. Unset, `POST /v1/events` and `POST /v1/business-events` return `503`. |
| `KAFKA_BUSINESS_EVENTS_TOPIC` | No | `business-events` | Topic for accepted business events. Default `business-events`. Create it before the first request. |
| `KAFKA_INGESTION_API_TOPIC` | No | `ingestion-api-events` | Topic for person events accepted by `POST /v1/events`. Default `ingestion-api-events`. Set it to the value event ingestion has, which reads the same variable. |
| `INGESTION_KAFKA_SSL` | No | `true` | `true` connects over TLS. Any other value, or unset, connects in plaintext. |
| `INGESTION_KAFKA_SASL_MECHANISM` | No | `scram-sha-512` | `plain`, `scram-sha-256`, or `scram-sha-512`. Unset means no SASL. Any other value makes the route return `503`. |
| `INGESTION_KAFKA_SASL_USERNAME`, `INGESTION_KAFKA_SASL_PASSWORD` | With `INGESTION_KAFKA_SASL_MECHANISM` | | Both required with SASL, or the route returns `503`. Put the password in a Kubernetes secret. |
| `INGESTION_RATE_LIMIT_PER_SECOND` | No | `100` | Integer from 1 to 100000. Default 100. Requests one source key may send in any second, counted per app process. An invalid value makes the route return `503`. |
| `IMPORTS_BUCKET` | For the import API | `cdp-free-plan-flink` | The bucket of the data import drop zone. Files land under `imports/incoming/`. Unset, `POST /v1/imports`, its `complete`, and `POST /v1/records/{record_type}` return `503`. Studio signs upload URLs and reads objects with the AWS credentials of its runtime, from the SDK's default chain, and the region from `AWS_REGION`. Those credentials need `s3:PutObject` and `s3:GetObject` on `imports/incoming/*`. Leave it unset in production until the drop zone and the import store are encrypted at rest (DIM-NFR-08). |
| `IMPORT_TOMBSTONE_KEY` | For deleting a person on `/data/privacy` | Output of `openssl rand -base64 32` | At least 32 characters. Unset or shorter, the Privacy page shows deletion as not configured and refuses requests. The tombstone is the HMAC-SHA-256 of the customer key under this value, in lowercase hex, so the import applier and the import metric pass must use the same value. Never rotate it: a new value makes every tombstone miss. Put it in a Kubernetes secret and in the secret backup. |
| `DEAD_LETTER_KAFKA_BROKERS` | For the dead-letter browser and the home page's dropped-record count | `kafka-0:9092,kafka-1:9092` | Comma-separated brokers. Unset, every dead-letter read fails with "not configured". |
| `KAFKA_EVENT_DEAD_LETTER_TOPIC` | No | `snowplow-parsed-dead-letters` | The topic that studio reads dead letters from. Default `snowplow-parsed-dead-letters`. Set it to the value event ingestion has, which reads the same variable. |
| `DEAD_LETTER_GROUP_PREFIX` | No | `studio-dead-letters-` | Default `studio-dead-letters-`. Letters, digits, `.`, `_`, and `-` only, ending with `-`, or every read fails with "not configured". The trailing `-` keeps a prefixed ACL from also matching a pipeline group, such as `event-processor-group` under `event-processor`. Each read uses a consumer group named with this prefix and a random UUID, commits no offset, and deletes the group when it ends. On a broker with authorization, grant studio's user read on the topic and on groups with this prefix, and nothing else. |
| `DEAD_LETTER_KAFKA_SSL` | No | `true` | `true` connects over TLS. Any other value, or unset, connects in plaintext. |
| `DEAD_LETTER_KAFKA_SASL_MECHANISM` | No | `scram-sha-512` | `plain`, `scram-sha-256`, or `scram-sha-512`. Unset means no SASL. Any other value makes every read fail with "not configured". |
| `DEAD_LETTER_KAFKA_SASL_USERNAME`, `DEAD_LETTER_KAFKA_SASL_PASSWORD` | With `DEAD_LETTER_KAFKA_SASL_MECHANISM` | | Both required with SASL. Use a user that may only read the topic, not the data ingestion API's user. Put the password in a Kubernetes secret. |
| `PLATFORM_TOOLS` | For the platform console | See [Platform console](#platform-console) | A JSON array of tools for `/platform`. Read once per app process. Unset or not a JSON array, the page shows no tools and says why. |
| `PLATFORM_QUICK_LINKS` | No | `[{"label":"Repository","url":"https://github.com/acme/repo"}]` | A JSON array of links, each with a `label` and an `http:` or `https:` `url`. The page skips an invalid entry and logs a warning. |
| `PLATFORM_ARGOCD_TOKEN` | No | (secret) | An Argo CD API token that can list applications. Unset, Argo CD's health shows `unknown`, "not configured". Put it in a Kubernetes secret. |
| `PIPELINE_DASHBOARDS` | No | `[{"name":"Flink jobs","url":"https://grafana.example.com/d/flink-jobs"}]` | A JSON array of the Grafana dashboards that the event catalog view of studio v2, `/v2/data/events`, links to, each with a `name` and an `http:` or `https:` `url`. Read once per app process. Unset, blank, or not a JSON array, the panel is hidden from editors and reads "No dashboards configured" to admins. The page skips an invalid entry and logs a warning. Every staff user sees the links, so list only dashboards that editors may open. |
| `TRACKING_COLLECTOR_URL` | No | `https://collect.acme.com` | The collector address that Tracking setup, `/v2/data/tracking`, puts in its tracker samples, and that Tracking setup and Sources, `/v2/data/sources`, name for server person events. An `http:` or `https:` URL without a query or credentials; a trailing `/` is dropped. Read on every request. Unset, blank, or invalid, the pages show `https://<collector address>` and say Studio does not know it. The data ingestion API's address needs no setting: it is the origin of `OIDC_REDIRECT_URL`. |
| `TRACKING_APP_IDS` | No | `acme-web,acme-app` | Comma-separated app ids, one per site or app. Tracking setup samples the first and names the others. Letters, digits, `.`, `_`, and `-` only, starting with a letter or digit; the page skips an invalid or repeated id. Read on every request. Unset or with no valid id, the samples show `<app id>` and the page says Studio does not know it. |
| `STUDIO_WORKSPACE_NAME` | No | `Acme Retail` | The workspace name in the top bar of studio v2, under `/v2`. Read on every request. Unset or blank, it reads `Studio`. |
| `PLATFORM_DOMAIN`, `PLATFORM_COGNITO_POOL_ID` | No | `50-16-20-162.sslip.io` | Not read by the app. The AWS Free Plan manifest sets them so that `PLATFORM_TOOLS`, `PLATFORM_QUICK_LINKS`, `PIPELINE_DASHBOARDS`, and `TRACKING_COLLECTOR_URL` can refer to them as `$(PLATFORM_DOMAIN)`, which Kubernetes expands. |

Locally these go in `studio/.env.local`. In a deployment they go in the container environment. Put `OIDC_CLIENT_SECRET`, each `OIDC_<ID>_CLIENT_SECRET`, `SESSION_SECRET`, `INGESTION_KAFKA_SASL_PASSWORD`, `DEAD_LETTER_KAFKA_SASL_PASSWORD`, and `PLATFORM_ARGOCD_TOKEN` in a Kubernetes secret. The data ingestion API's producer, shared by both routes, is transactional, with the transactional id `studio-ingestion-<hostname>`, so its Kafka user needs write and transactional-id permissions. The app also reads `NODE_ENV`, which Next.js sets and the container image sets to `production`. Only in production does `OIDC_ISSUER`, or `OIDC_<ID>_ISSUER`, require `https:`.

### OIDC provider setup

Register a confidential web client at the provider, with the authorization code grant and the redirect URI from `OIDC_REDIRECT_URL`. Also register `/login` on the same origin, for example `https://studio.example.com/login`, as a post-logout redirect URI. **Logout** sends it to the provider's `end_session_endpoint`, and the provider sends the user back there.

| Provider | `OIDC_ISSUER` | Notes |
|---|---|---|
| Google | `https://accounts.google.com` | Sends no roles or groups claim in the ID token, so it cannot be used alone. Put a provider that can, such as Keycloak, in front of it. |
| Microsoft Entra | `https://login.microsoftonline.com/<tenant-id>/v2.0` | Use the tenant id, not `common` or `organizations`, whose issuer differs from the token's `iss`. Add the optional `email` claim to the ID token. Define app roles, such as `Studio.Admin` and `Studio.Editor`, on the app registration, assign users or groups to them, and set `OIDC_ROLE_CLAIM=roles`. Set **Assignment required** on the enterprise application so unassigned users cannot sign in. Prefer app roles to the `groups` claim: Entra leaves `groups` out for a user in more than 200 groups, and that user is refused. |
| Okta | `https://<org>.okta.com` or a custom authorization server | Add a `groups` claim to the ID token with a filter for the Studio groups, and set `OIDC_ROLE_CLAIM=groups`. Okta refuses the sign-out redirect without `id_token_hint`. Set `OIDC_LOGOUT_ID_TOKEN_HINT=true`. |
| Keycloak | `https://<host>/realms/<realm>` | Enable **Client authentication** on the client. Add the `/login` URL to **Valid post logout redirect URIs**. Add a mapper to the client's dedicated scope that puts the roles or groups in the ID token at the top level: a **User Realm Role** mapper with the token claim name `roles`, or a **Group Membership** mapper with `groups`. Keycloak's default `realm_access.roles` is nested and is not read. |

Every sign-in writes the role from the token to the user's row, so assign and change roles at the provider. Each staff user belongs to one provider account, the token's `iss` and `sub`. Changing `OIDC_ISSUER`, or moving to another provider, gives each person a new account and a new row at their next sign-in. Their old rows keep their campaigns, and Studio does not move them.

### Several providers

Set `OIDC_PROVIDERS` to offer more than one provider. The login page then shows one **Sign in with** button per provider, in the listed order, labeled with `OIDC_<ID>_NAME` or else the id. Register the same `OIDC_REDIRECT_URL` and post-logout URL at each provider.

```bash
OIDC_PROVIDERS=keycloak,entra
OIDC_KEYCLOAK_ISSUER=https://keycloak.example.com/realms/cdp
OIDC_KEYCLOAK_CLIENT_ID=studio
OIDC_KEYCLOAK_CLIENT_SECRET=<secret>
OIDC_KEYCLOAK_NAME=Keycloak
OIDC_ENTRA_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0
OIDC_ENTRA_CLIENT_ID=<application id>
OIDC_ENTRA_CLIENT_SECRET=<secret>
OIDC_KEYCLOAK_ROLE_CLAIM=groups
OIDC_KEYCLOAK_ROLE_MAP='{"/studio/admins":"admin","/studio/editors":"editor"}'
OIDC_ENTRA_NAME=Microsoft
OIDC_ENTRA_ROLE_CLAIM=roles
OIDC_ENTRA_ROLE_MAP='{"Studio.Admin":"admin","Studio.Editor":"editor"}'
```

Each provider account has its own staff user. A person who signs in at two providers gets two users, each with the role its provider gives.

Without `OIDC_PROVIDERS`, the unprefixed variables describe one provider with the id `default`. Moving to `OIDC_PROVIDERS` keeps every user, because users hold the issuer and not the id. Sessions signed in before the move sign out at the provider only if their provider id still exists.

### Platform console

`PLATFORM_TOOLS` lists the tools on the admin page `/platform`. Each entry has these fields:

| Field | Rules |
|---|---|
| `id` | Non-empty and unique. A later entry with the same id is skipped. |
| `name` | Non-empty. The card's title. |
| `purpose` | One line on the card. |
| `url` | The public address the card links to. `http:` or `https:` only, as for every URL here. |
| `signIn` | `sso` for a tool that signs in through studio's identity provider, or `own-login`. |
| `health` | How studio's server checks the tool, from inside the cluster. `{"kind":"argocd","url":...}`, `{"kind":"grafana","url":...}`, `{"kind":"http","url":...}`, or `{"kind":"flink","jobs":[{"name":...,"url":...}]}`. Each `url` is the tool's internal base address. A Flink job's `url` is its REST service, and the card links to `<url of the tool>/<job name>/`. |
| `links` | Optional. More links for the card, each with a `label` and a `url`. |

The page shows Argo CD, Grafana, and Flink kinds first, then other tools in the listed order. An entry without an `id` or a `name` is skipped with a warning in the log. An entry with both whose other fields are invalid shows as a card with health `unknown`, "not configured".

```bash
PLATFORM_TOOLS='[{"id":"grafana","name":"Grafana","purpose":"Dashboards","url":"https://grafana.example.com","signIn":"sso","health":{"kind":"grafana","url":"http://grafana.monitoring.svc"}}]'
```

Studio checks each tool at most once per 15 seconds per app process, with a 3-second timeout. The rules for each kind are in the [platform console contract](../features/platform-console.md#health-of-a-tool).

## Data import

Data import is planned ([data import](../features/data-import.md)). Its settings have no variable names yet. The lane that builds each reader names the variable and replaces its row here with the variable, its default, and its rules.

| Setting | Read by | Default | Effect |
|---|---|---|---|
| Reporting time zone | Import metric pass, import applier, studio | `Asia/Ho_Chi_Minh` | IANA zone of the nightly schedule and of datetimes without an offset. Shown read-only on `/settings`. |
| Default phone country | Import applier, studio | `VN` | Country for phone numbers without a country code. Shown read-only on `/settings`. |
| Tombstone key, `IMPORT_TOMBSTONE_KEY` in studio | Import applier, import metric pass, studio | None, required | Secret that keys the tombstone HMAC. Created once per deployment and never rotated, because a new key makes every tombstone miss. Keep it in a secret and in the deployment's secret backup. |
| Import store connection | Import applier, import metric pass, studio | None | Host, database, user, and password of the import store. Studio's user may only read. |
| Drop zone bucket and prefix, `IMPORTS_BUCKET` in studio | Import applier, studio | `imports/` in the deployment's bucket | Where files land. Lifecycle: `incoming/` 30 days, `rejects/` 14 days. |
| Applier interval | Import applier | 10 minutes | How often the applier starts and drains the queue |
| Reject threshold | Import applier | 5% | Share of rejected rows that quarantines a run |
| Snapshot shrink ratio | Import applier | 80% | Share of the writer's last snapshot below which a snapshot is quarantined |
| Record cap | Import applier | 5,000,000 | Most rows `import_records` may hold |
| History limit, future limit | Import applier | 3 years, 1 day | Event time range a row may have |
| Pass schedule | Import metric pass | 03:00 | Local time of the nightly pass, in the reporting time zone |
| Pass job interval | Import metric pass | 10 minutes | How often the pass job starts to look for the night's pass or a requested retry |
| Batch size | Import metric pass | 500 rows | Upserts between two governor checks |
| Own WAL rate | Import metric pass | 0.25 MB/s | Most WAL the pass's own statements write per second on the main Postgres |
| Cluster WAL pause and resume | Import metric pass | 2 MB/s and 1.5 MB/s | Pause while the main Postgres's total WAL rate is above the first, resume under the second |
| Slot pause and resume | Import metric pass | Half and two thirds of `max_slot_wal_keep_size` | Pause while any slot's `safe_wal_size` is under the first, resume above the second. No cap set counts as a missing reading, so the pass pauses. |
| Disk pause and resume | Import metric pass | 20% and 25% free | Pause while the worse of the node filesystem's free share and the database's free share of its claim is under the first, or either is unknown. Resume when both are above the second. |
| Free disk source | Import metric pass | None | The monitoring query that gives the free bytes of the main Postgres node's root filesystem |
| Main Postgres claim size | Import metric pass | The claim's size, 8 GiB today | The size the database's bytes are compared with |

## Database bootstrap

A deployed database gets its schema from the migration Job `db-migrate`. Its settings are fixed in `infra/db/flyway.toml` and in the Job's manifest, `infra/k8s/data/db-migrate.yaml`, which sets the `FLYWAY_*` variables and reads the database name, user, and password from the secret `cdp-pg-app`. An operator sets nothing. See [deployment](deployment.md#database).

The import store, `cdp-import-pg`, gets its tables from the Job `import-store-ddl`, which reads the database name, user, and password of `cdp_import` from the secret `cdp-import-pg-app` that CloudNativePG creates. The read-only role `import_reader` takes its password from the secret `cdp-import-pg-reader`, of type `kubernetes.io/basic-auth` with `username: import_reader` and a `password`. An operator creates that secret once, before the first sync of the import store, and keeps it in the secret backup.

For a local run, `infra/local/init-db.sh` applies `schema.sql`. It creates no staff user: each one's first sign-in does. With `DB_HOST` set, the script resets that database with `DB_PORT` (default `5432`), `DB_USER` (default `postgres`), `DB_NAME` (default `auroracy`), and `DB_PASSWORD` (required). With `DB_HOST` empty, it resets the local `postgres-db` container and always uses the database `auroracy`, ignoring `DB_NAME`.
