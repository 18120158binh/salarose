# Glossary

Terms used across the code and these documents. Where the UI and the code use different words for one thing, both are listed.

| Term | Meaning |
|---|---|
| Archived metric | A metric that staff archived on **Data > Metrics** after nothing used it. It stops updating, keeps its last values, and no condition picker offers it. Unarchive brings it back. Metrics are never deleted. See [campaign management](../features/campaign-management.md#metric-definitions). |
| Audience | The sidebar group in studio that holds **Segments**. The page and the routes say Segments. |
| Behavior condition | A condition on what a person did over a window, such as `add_to_cart` `COUNT >= 3` in the last 7 days. Publish derives its metric. |
| Behavior version | A per-person counter on each profile mutation. It only increases, and it orders the writes to `user_metrics`. |
| Branch | The outcome of a completed node: `next`, `yes`, `no`, `success`, `timeout`, `else`, or a multi-branch key. A child node hangs off one branch of its parent. |
| Business event | An event about an item, such as `price_drop`, with no person. Catalog kind `business`. See [business event fan-out](../architecture/components/business-event-fan-out.md). |
| Campaign | A journey with a status: `draft`, `active`, or `paused`. The UI uses "campaign" and "journey" for the same thing. |
| `canon_id` | The stitched id of one person across devices and logins. Every job keys its state by it. |
| CDC | Change data capture. Flink jobs read Postgres changes through logical replication slots and publications. |
| Check node | A node that tests its conditions when its trigger event arrives, and branches `yes` or `no`, or into named branches. |
| Classic studio | The studio pages outside `/v2`, such as `/campaign` and `/segments`. Studio v3 retires them in stages: they redirect at cutover and are deleted after a one-week soak. See [decision 0037](../architecture/decisions/0037-one-studio-retire-the-classic-studio.md). |
| Collector | The OpenSnowcat service that receives tracker hits and writes them to Kafka. |
| Completed, Entered, Waiting | Node analytics in studio v2. Entered counts the entries that reached a node in a time range. Completed counts those of them that completed it by now, and Waiting those that have not. See [node analytics](../features/journey-builder.md#node-analytics). |
| Condition | A typed test on the person: a profile field or behavior over a window. Conditions come in groups. See [the journey builder](../features/journey-builder.md#conditions). |
| Condition split | A node with conditions and no trigger event, formerly the segment node. It takes `yes` when its conditions hold, checked when a person reaches it and each time one of its metrics changes. It never takes `no`. See [journey execution](../architecture/components/journey-execution.md#segment-checks). |
| Customer attributes | One row per customer and imported source in `customer_attributes`: a profile dataset's columns, or an event dataset's imported metric values. Written only by the [import metric pass](../architecture/components/import-metric-pass.md). |
| Customer key | The shop's customer id in imported records. It must equal, byte for byte, the `user_id` the trackers send. See [data import](../features/data-import.md). |
| Cutover | The step of studio v3 at which `/` and the sign-in default go to the v2 home and every classic URL redirects in one hop to its v2 page. See [decision 0037](../architecture/decisions/0037-one-studio-retire-the-classic-studio.md). |
| Dataset | One kind of row a shop imports, such as `orders` or `customers`, of kind `profile` or `event`. Studio's page is **Data > Datasets**. The tables and the import API call it a record type: `import_record_types`, `record_type`. See [data import](../features/data-import.md#datasets). |
| Dataset metric | The UI name for an imported metric. |
| Dead letter | A payload or event that ingestion dropped, kept with its drop reason on the [dead-letter topic](../features/data-health.md#terms), `snowplow-parsed-dead-letters` by default. It holds personal data. See [decision 0017](../architecture/decisions/0017-keep-dropped-ingestion-input-in-a-dead-letter-topic.md). |
| `domain_userid` | A first-party cookie or device id. Exists before login. |
| Draft | An unpublished journey, saved on the server in `journey_drafts` and private to its owner. Its id becomes the campaign id at publish. Not the same as a campaign with status `draft`. See [decision 0036](../architecture/decisions/0036-store-journey-drafts-on-the-server-outside-cdc.md). |
| `eid`, `event_id` | Snowplow's id for one event. Used to deduplicate. |
| End node | A node that ends a path. Completes automatically. |
| Engagement node | A node that sends a message on a channel. Completes automatically. Also called an action node. |
| Engine lag | For one setup or check transition, or a watch transition on `success`, the time the engine wrote it minus the time of the event that completed the node. Other transitions take their parent's time or a watch deadline, so they are left out. See [the home overview](../features/home-overview.md#terms). |
| Entry | One person's pass through one campaign. A journey instance. A person can have several entries in a campaign triggered by a segment entry or a business event. |
| Event catalog | The list of event names and their attributes in `user_events` and `user_event_fields`. |
| `event_json` | The event's own attributes, such as `product.price`. Rules refer to them by dotted path. |
| Filter | A test on an attribute of an event: the trigger event, or the event a behavior condition counts. |
| Group | A list of filters or conditions. A group passes when any of them passes, and every group must pass. |
| Held for review | The UI name for an import run at `quarantined`: the applier stored nothing, and an admin approves or discards it. |
| Identifier | A type and a normalized value that point at one person, such as `user_id` `usr_1001`. See [identifiers](../architecture/components/identity/identifiers.md). |
| Identity merge | Joining two people's identity sets into one when an event links them. One `canon_id` wins and the other is retired. See [identity merges](../architecture/components/identity/identity-merges.md). |
| Import run | One delivered import file and its states from upload to applied. Table `import_runs`. See [the import applier](../architecture/components/import-applier.md#run-states). |
| Import store | The second Postgres cluster, `cdp-import-pg`, that holds accepted imported records. See [decision 0040](../architecture/decisions/0040-import-through-a-batch-path-and-a-separate-store.md). |
| Imported field | A value a condition names as `<source>.<name>`, such as `orders.spend_90d`. Customer decision reads it from `customer_attributes`. |
| Imported metric | A function over one imported dataset, such as `SUM` of `total` over 90 days, computed once a night. Table `import_metric_definitions`. Not a metric in `user_metric_definitions`. |
| Imported-only customer | A customer key that data import knows, with rows in `customer_attributes`, and that maps to no tracked person. The nightly segment pass evaluates segments for it. |
| Interest | A business trigger's audience: people who did an event on the same item at least N times in a window. |
| Journey instance | One person in one campaign. Key: `canon_id` + U+001F + `campaign_id`. |
| Matched event, trigger | A record that a person's event satisfied one node's condition on one branch. Topic `journey-engine-matched-events`. |
| Metric | One event, one function such as `COUNT` or `SUM`, optionally one attribute, and filters. Publish derives it from a behavior condition, with an id `m_` and 16 hexadecimal digits. |
| Nightly segment pass | A batch job that runs once a night after the data-import metric pass, evaluates every segment for imported-only customers, and writes changed rows to `segment_import_members`. It starts no journey. See [the segment membership pass](../architecture/components/segment-membership-pass.md). |
| Outbox | The `outbox` Flink job. It reads new rows of `user_campaign_state_transitions` and publishes notification requests and watch timeouts. |
| PII column | An imported column that holds personal data: every email and phone column, and any column an admin flags. Studio masks it in every response, for every role. |
| Preview flag | `system_users.preview`. Opens routes at stage `preview` to an editor. Admins reach them without it. |
| Previous period | The span of the same length just before a time range, used for the change shown next to a number in studio v2. See [the studio shell](../features/studio-shell.md#time-ranges). |
| Processing mode | `LIVE` or `PAUSED` on a metric definition. Only `LIVE` metrics are computed. An archived metric stays `PAUSED`. |
| Profile mutation | The metric changes one event caused for one person. Topic `customer-profile-mutations`. |
| Publish checklist | The list of every problem that blocks or warns before a journey publishes, grouped by node, from the same validator the server runs at publish. |
| Relative-date operator | `more_than_days_ago` or `within_last_days`, which compare a datetime profile field with the check time. See [customer decision](../architecture/components/customer-decision.md#condition-language). |
| Runtime registry | The one list of trigger kinds, condition types, and editor options that the runtime evaluates, and of the size views whose stored membership the runtime writes. The builder and the segment pages offer only what it lists. |
| Segment | A saved, named list of condition groups that campaigns use to start a journey on entry, or as a condition. See [segments](../features/segments.md). |
| Segment check | A request from the state machine to customer decision to check a condition split that a person just reached. Topic `journey-engine-segment-checks`. |
| Segment size | A segment's rows in `segment_members` plus its rows in `segment_import_members`: tracked members as of their last event, and imported-only customers as of the last nightly pass. |
| Setup node | The first node of a journey. Holds the trigger event and its conditions. |
| Snowplow | The tracker protocol and SDKs the site uses to send events. |
| Stage | A route's release state in the studio shell's route table: `preview`, `shipped`, or `reserved`. |
| Studio v2 | The new studio pages under `/v2`, built next to the classic studio. After the classic studio is removed, the `/v2` prefix drops and they are the only studio. See [the studio shell](../features/studio-shell.md). |
| Template | A built-in journey shipped with the code, with a key, a name, a purpose, and the catalog events it needs. Choosing one creates a draft with `origin = template:<key>`. |
| Time range | Today, Last 7 days, or Last 30 days, in the viewer's time zone. See [the studio shell](../features/studio-shell.md#time-ranges). |
| Tombstone | The HMAC-SHA-256 of a deleted person's customer key under a deployment secret, in `person_tombstones`. Every later import rejects the key. |
| Transition | A completed node for a journey instance. Table `user_campaign_state_transitions`. |
| Trigger event | A node's event name and the filters on that event. The journey builder calls it the trigger. Not to be confused with a trigger message on `journey-engine-matched-events`. |
| `user_event_id` | The id of a catalog event in `user_events`. Metric definitions and metric conditions use it. |
| `user_id` | The logged-in account id. |
| Waiting step | A node where one entry is now: its parent completed on the node's branch, and the node has not. See [node analytics](../features/journey-builder.md#node-analytics). |
| Watch limit | How long a watch node waits for its event. Default 15 minutes. |
| Watch node | A node that waits for an event up to a time limit and branches `success` or `timeout`. With `DelayPath`, it only waits. |
