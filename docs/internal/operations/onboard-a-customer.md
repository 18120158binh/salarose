# How to onboard a customer

This guide takes a new customer from first call to the first events arriving with a stitched identity. A customer here is a company whose website or app sends tracking data, and whose marketers build journeys in `studio`. The default path is the Snowplow tracker, sending to our collector. A customer that already has its own tracking can send its events to the collector over the tracker protocol instead.

Give the customer's developers [the tracking integration guide](../integration/tracking-guide.md). This page is for us.

## Before you start

- **One customer, one deployment.** The platform has no tenant concept. Two customers on one deployment would share one event catalog and one set of campaigns, and could merge each other's people. Provision a full environment per customer. [Decision 0027](../architecture/decisions/0027-multi-tenancy.md) weighs the alternatives.
- **Read the known issues before you set a launch date.** [The known issues](../known-issues/README.md) list what still breaks, by feature and severity. Walk the customer through the ones that touch their use cases.
- **Notifications need a sender that does not exist.** The outbox publishes requests to `journey-engine-outbound-noti`, and nothing in this repo delivers them. A sender is outside this repo by design. Agree with the customer who builds the sender, or whether their system consumes the topic.

## 1. Collect what you need from the customer

Send this list before the kickoff, and fill in the answers in the customer's onboarding ticket.

| Item | Why we need it | Example |
|---|---|---|
| Sites and apps, with their domains | Collector host name, cookie domain, CORS origins | `shop.example.vn`, iOS app `vn.example.shop` |
| Tracker platforms | Which part of the integration guide applies | Web (JavaScript), iOS, Android, server |
| Login identity | The value sent as the user id. It joins devices to people and keys the profile feed. | Phone number, or the account id |
| Event list, with one sample payload each | Event catalog entries and journey conditions | `view_product`, `add_to_cart`, `purchase` |
| Existing tracking | Whether they already run Snowplow, another tool, or nothing | Snowplow with vendor `com.example` |
| Staff identity provider and staff emails | `studio` sign-in through OIDC | Google Workspace, 3 marketers, 1 admin |
| Profile data source | Feeds `customer_profiles`, which profile conditions and messages read | Nightly export from their CRM |
| Message channels and the sender | What the engagement nodes will send, and who delivers it | Push through Firebase, SMS through a local gateway |
| Volume | Kafka partitions, Flink parallelism, database size | 2 million events a day, peak 300 a second |
| Region and data residency | Where to provision | Singapore, data must stay in Vietnam |
| Consent | Whether tracking needs a consent banner and how it gates the tracker | Track after consent only |

## 2. Provision the environment

Follow [the deploy skill](../../../.agents/skills/deploy/SKILL.md) for the chosen target, and check every row of [the runtime checklist](../../../.agents/skills/deploy/references/runtime-checklist.md): Postgres with logical replication, the schema, the six topics, the Flink image, and the `studio` settings. Then set the values that differ per customer.

| Setting | Value for this customer | Reference |
|---|---|---|
| Environment name and region | From the intake | |
| `KAFKA_EVENT_TOPIC_PATTERN` | `snowplow-good`. The default, `snowplow\.good\.events\..*`, does not match the collector's topic. | [Configuration](configuration.md#event-ingestion) |
| `EVENT_PARSE_PLACEHOLDER_IDS` | The default `unknown,undefined,null`, plus any placeholder the customer's trackers send for a missing id | [Configuration](configuration.md#event-ingestion) |
| `SNOWPLOW_LEGACY_CONTEXT_SCHEMA_PREFIX` | Only for apps that send the legacy `basic` context: `iglu:<their vendor>/` | [Configuration](configuration.md#event-ingestion) |
| `DB_*`, `DATABASE_URL` | The customer's own database | [Configuration](configuration.md) |
| `OIDC_*`, `SESSION_SECRET` | A client registered at the customer's identity provider, or ours | [Configuration](configuration.md#studio) |
| `OIDC_REDIRECT_URL` | `https://studio.<customer domain>/api/auth/oidc/callback` | [Configuration](configuration.md#studio) |
| `ADMIN_EMAIL` | The customer's first admin, an email the provider can sign in | [Configuration](configuration.md#database-bootstrap) |
| Collector host | `collector.<customer domain>`. See the next section. | |
| App id per site and app | Agree one value per app, such as `shop-web` and `shop-ios`. Nothing reads it yet, but it shows the source of each event. | |

### Collector in production

The local `infra/local/collector.config` is not production-ready. For each customer:

1. **Serve it on the customer's domain.** Use a subdomain such as `collector.example.vn`, so that the collector cookie is first-party. Browsers block or shorten third-party cookies, and the cookie carries the network user id.
2. **Put TLS in front.** Terminate HTTPS at the load balancer or the ingress. Trackers on HTTPS pages cannot send to an HTTP collector.
3. **Set the cookie domain.** Set `cookie.domains` to the customer's parent domain, such as `[".example.vn"]`. The local file leaves it empty, which pins the cookie to the collector's own host.
4. **Point it at the customer's brokers.** Replace the hard-coded `redpanda:29092` in `streams.sink.brokers`, and add the Kafka security settings the brokers need, such as SASL over TLS on MSK.
5. **Know how CORS works.** OpenSnowcat 1.2.1 has no allow list. It echoes the request's `Origin` with credentials allowed, so any site can post to it. Its cookie is `Secure`, `HttpOnly`, and `SameSite=None` by default, which needs HTTPS. [Source](https://github.com/opensnowcat/opensnowcat-collector/blob/1.2.1/core/src/main/scala/com.snowplowanalytics.snowplow.collectors.scalastream/CollectorService.scala)
6. **Size `snowplow-good`.** Give it enough partitions for the peak rate from the intake.
7. **Know that it has no authentication.** Anyone who finds the URL can send events, with any user id (ING-KI-12). If that matters to the customer, put a WAF or an allow list in front, and record the decision.

## 3. Pick the ingestion path

| Customer situation | Path | What the customer does |
|---|---|---|
| New tracking on a website or app | Snowplow tracker SDK (default) | Follows the [web](../integration/tracking-guide.md#web-javascript-tracker) or [mobile](../integration/tracking-guide.md#mobile-trackers) section of the guide |
| Server-side events: orders, payments | Snowplow server-side tracker, or a raw tracker-protocol POST | Follows [server-side events](../integration/tracking-guide.md#server-side-events) |
| Already runs Snowplow | Point the existing trackers at our collector, or add our collector as a second destination | Checks the [rules for events](../integration/tracking-guide.md#design-your-events) against their schemas |
| Runs another tool and won't re-instrument | Convert their events to tracker-protocol POSTs on their side | Same as server-side events |

The [data ingestion API](../features/data-ingestion-api.md) would give the last two a plain JSON endpoint. It is a draft and not built.

Writing straight to the Kafka topics is possible for an operator, and is not something to offer a customer. A Thrift collector payload on `snowplow-good` goes through parsing and stitching. Parsed JSON on `snowplow-parsed` skips stitching, so its `canon_id` values would not match the tracker's.

## 4. Set up studio

1. **First admin.** Run `infra/local/init-db.sh`, or the same insert, against the new database once. The admin signs in at `https://studio.<customer domain>`.
2. **Staff.** Staff are created at their first sign-in, with the role the customer's identity provider gives. See [admin authentication](../features/admin-authentication.md) and [decision 0024](../architecture/decisions/0024-create-staff-at-first-sign-in-with-the-providers-role.md).
3. **Event catalog.** The admin adds every event from the intake at `/admin/events`. Paste each sample payload to infer the attributes.
	- The system name must equal the parsed `event_name` exactly. The guide's [event name rules](../integration/tracking-guide.md#how-the-event-name-is-chosen) say how it is chosen.
	- Attribute paths must equal the dotted paths inside the event's data, such as `product.price`.
	- Nothing checks the catalog against real traffic. A typo in either place means a rule never matches.
4. **Profile feed.** Agree with the customer how `customer_profiles` gets filled. The [profile data section](../integration/tracking-guide.md#profile-data) of the guide gives the columns. `cdp_uuid` must hold the same value the trackers send as the user id. Without the feed, profile conditions never match, and messages carry no contact details.
5. **Metrics.** Don't create them by hand. Publishing a campaign creates the metric definitions its conditions need. See [campaign management](../features/campaign-management.md).
6. **Preview access.** Pages at stage `preview` are open to admins and to editors with the preview flag ([decision 0037](../architecture/decisions/0037-one-studio-retire-the-classic-studio.md)). Studio has no staff-management screen, so an admin grants the flag in SQL after the editor's first sign-in. The email is not unique, so check that the statement changed exactly one row:

	```sql
	UPDATE system_users SET preview = true
	WHERE email = 'editor@shop.example' AND role = 'editor'
	RETURNING id, email, oidc_issuer;
	```

	Set `preview = false` the same way to take it back. The change applies at the editor's next request, with no restart. `/settings` lists who has the flag.

## 5. Verify the first events

Ask the customer to send one test event from each platform, or send the raw example from [the guide](../integration/tracking-guide.md#send-a-raw-tracker-protocol-request) yourself. Then check each stage:

```bash
# 1. The hit reached the collector topic, and nothing failed
rpk topic consume snowplow-good -n 1 -o -1        # or kafka-console-consumer.sh on MSK
rpk topic consume snowplow-bad -n 1 -o -1         # expect nothing new

# 2. The parsed event has a name, its attributes, and a canon_id
rpk topic consume snowplow-parsed -n 5 -o -5 | grep '"event_name":"view_product"'
```

```sql
-- 3. The device has an identity row, and it links to the user after login
SELECT domain_userid, user_id, canon_id FROM identity_graph WHERE domain_userid = '<duid from the test>';
```

If the hit is on `snowplow-good` but not on `snowplow-parsed`, the parser dropped it. The event parse job logs a `Dropping ...` line with the reason, at most once a minute per reason, and its `droppedEvents` counter goes up under the reason's group. Check the guide's [what gets dropped](../integration/tracking-guide.md#what-gets-dropped) list against the payload. The usual causes are an `eid` that is not a UUID and a missing timestamp.

## 6. Hand over and run

- Give the customer's admin the `studio` URL and a short walkthrough of the catalog and the builder.
- Agree how new events get added. The customer's developers send a sample payload. The admin adds the catalog entry before the tracker ships, so that marketers can use the event on day one.
- Watch `snowplow-bad` and the gap between `snowplow-good` and `snowplow-parsed`. Nothing in the platform reads `snowplow-bad`, so check it by hand after each tracker release. Events that the parser drops go to `snowplow-parsed-dead-letters` instead ([decision 0017](../architecture/decisions/0017-keep-dropped-ingestion-input-in-a-dead-letter-topic.md)).
- Record the version this customer runs. With one deployment per customer, each release rolls out once per customer.

## Checklist

| Step | Done when |
|---|---|
| Intake | Every row of the table in step 1 has an answer |
| Environment | The deploy skill's summary table shows 5 of 5 jobs running and `studio` answering |
| Collector | HTTPS on the customer's subdomain, cookie domain set, test hit on `snowplow-good` |
| Tracker | One test event per platform reaches `snowplow-parsed` with a `canon_id` |
| Identity | A login on two devices gives one `canon_id` in `identity_graph` |
| Catalog | Every intake event is in `/admin/events`, with names that match the parsed events |
| Profiles | `customer_profiles` has rows whose `cdp_uuid` matches the tracker's user ids |
| Handover | The customer's admin can sign in and add a marketer |

## Related

- [Tracking integration guide](../integration/tracking-guide.md), for the customer
- [The deploy skill](../../../.agents/skills/deploy/SKILL.md) and [the runtime checklist](../../../.agents/skills/deploy/references/runtime-checklist.md)
- [Event ingestion](../architecture/components/event-ingestion.md) and [identity stitching](../architecture/components/identity/identity-stitching.md)
- [Decision 0027](../architecture/decisions/0027-multi-tenancy.md)
