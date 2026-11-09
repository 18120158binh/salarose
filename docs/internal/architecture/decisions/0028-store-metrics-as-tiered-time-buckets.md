---
title: Store metrics as tiered time buckets
id: "0028"
status: accepted
date: 2026-10-21
tags: [metrics, state, flink, accuracy]
supersedes: []
superseded_by: []
---

# 0028. Store metrics as tiered time buckets

## Context

A metric condition such as "added to cart at least 3 times in the last 7 days" reads a person's series for one metric. Until now a series was a list of raw occurrences: event id, event time, and value. It held at most `max_retention_value` of them, 100 by default, and dropped the oldest when it went over. The job applied the function and the window when it evaluated a rule.

The cap made answers depend on how active the person was:

- **Counts became lower bounds.** A series that dropped occurrences stores none older than the ones it dropped. A window that starts after the oldest stored occurrence gets an exact count. A window that reaches back past it, which includes every condition without a window and long windows for active people, gets only "at least the stored number", so `<`, `<=`, and `=` fail there.
- **Late events were dropped.** To keep those exact counts true, a late event older than the oldest stored occurrence of a truncated series is not counted, even after the cap is raised.
- **Every other function was silently wrong.** `SUM`, `AVG`, `MIN`, `MAX`, `MEDIAN`, and `DISTINCT_COUNT` ran over the stored occurrences as if they were all of them.

Raising the cap only raises the number of occurrences at which answers go wrong, and each event that a metric counts reads and writes more state.

The owner chose accuracy for active users as the problem to fix, on 2026-10-21. Backfilling a new metric from event history is out of scope. The platform keeps no event history outside Kafka, and the owner does not want to add a store for it.

## Decision

A series stores totals per bucket instead of raw occurrences. Buckets start at whole UTC minutes, hours, and days, so each minute lies inside one hour and each hour inside one day. The size of an occurrence's bucket depends on how far its bucket starts before the series clock, the newest event time counted in the series:

| Bucket start before the series clock | Bucket size |
|---|---|
| Less than 2 hours | 1 minute |
| From 2 hours to less than 8 days | 1 hour |
| 8 days or more, within the retention period | 1 day |

When the clock moves on, a bucket that has passed its limit merges into the larger bucket that holds it. A bucket counts in a window when any part of it is inside the window.

Every bucket holds the number of occurrences. It also holds what the definition's function needs: the sum, the minimum and maximum, or the two newest occurrences. `DISTINCT_COUNT` keeps an HLL sketch per bucket and `MEDIAN` keeps a KLL quantile sketch per bucket, both from Apache DataSketches. Both are accurate to about 2%. HLL with `lgK = 12` has a relative standard error of 1.62%, and 4.7% at three standard deviations. KLL with `k = 200` answers a quantile within 1.33% of its true rank, with 99% confidence. Sketches of the same kind merge, so a window merges its buckets' sketches.

The per-series cap `max_retention_value` goes away. The retention period and the bucket sizes bound a series instead.

The owner chose the bucket sizes and approximate summaries on 2026-10-21. The owner first saw limits of 1 hour and 7 days. This record uses 2 hours and 8 days so that a 1-hour window keeps a 1-minute edge and a 7-day window keeps a 1-hour edge. With limits of exactly 1 hour and 7 days, the old edge of a 7-day window would fall into a day bucket. The wider limits were chosen while writing this record, and are pending owner review. The owner's choices are in the decision log, `~/.claude/scripts/state/decisions.tsv`, from the design session of 2026-10-21.

## Why

Totals per bucket count every occurrence, so `COUNT`, `INACTION`, `SUM`, `AVG`, `MIN`, `MAX`, `LATEST`, and `DIFF` are exact over the buckets in a window, however active the person is. The truncation rules, and every comparison that cannot pass because of them, go away.

The only error left is at the edges of the window. Inside the window, every occurrence counts. At the old edge, a window can take in occurrences up to one bucket older than it asked for. For an event that arrives in order, that is at most 1 minute for windows up to 1 hour, 1 hour for windows up to 7 days, and 1 day for longer ones. Marketers write windows in minutes, hours, and days, so an edge rounded to the bucket still matches what they asked for. A count that stops at 100 does not.

Nested, aligned buckets make the state a function of the counted events alone. An occurrence that arrives late goes into the same bucket it would have reached by merging, so arrival order does not change the result. A replay rebuilds the same series, and [identity merges](../components/identity/identity-merges.md) fold two series by adding the buckets that have the same size and start.

The bucket count has a fixed limit. A series with the default 30-day retention holds at most 121 minute buckets, 193 hour buckets, and 23 day buckets, 337 in all, whatever the person's activity. Most series hold far fewer, because a bucket exists only after an occurrence goes into it.

Exact `MEDIAN` and `DISTINCT_COUNT` need every value, so their state would grow with activity and need a cap again. Fixed-size sketches keep their state bounded, with an error of about 2%.

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| Raise the cap | Moves the cliff to more active users, and makes every event read and send more state. |
| Keep the newest raw occurrences and roll older ones into buckets | Exact edges for most people, but two representations to keep in step in the job, in `user_metrics`, and in identity merges. The edge error it removes is at most one bucket. |
| Day buckets only | Simplest, but windows shorter than a day become impossible, and "the last 7 days" needs a time zone per deployment. |
| Exact `MEDIAN` and `DISTINCT_COUNT` with a cap on stored values | Keeps the truncation problem for those two functions. |
| Remove `MEDIAN` and `DISTINCT_COUNT` | Exact everywhere, but the builder already offers both, and a 2% error is acceptable for the conditions they serve. |
| Compute metrics from an event store when a rule needs them | Needs the event history store the owner ruled out, and puts a query on the decision path, which [decision 0004](0004-compute-metrics-and-decisions-in-one-keyed-job.md) removed. |

## Consequences

- The metric job stays one keyed job ([decision 0004](0004-compute-metrics-and-decisions-in-one-keyed-job.md)), and `user_metrics` stays a lagging copy ([decision 0005](0005-keep-live-state-in-flink.md)). What changes is the shape of the series in state, in each mutation on `customer-profile-mutations`, and in each `user_metrics` row.
- Window edges are approximate by up to one bucket. Contracts and the builder must say so, and acceptance tests must test the edge rule rather than expect an exact sliding window.
- Buckets carry no event ids, so a series cannot drop a duplicate on its own. Only the person's last 512 accepted event ids catch a duplicate (DEC-NFR-06). If a copy of an event arrives after 512 newer events of the same person, the job counts it twice. Under the old model, the series caught a copy for as long as the original occurrence stayed in it.
- The largest possible state grows, and typical state shrinks. Without sketches, a bucket is about 48 bytes for the fields one function needs, so a person at the limit in all 128 metrics holds about 2 MiB, against 800 KiB before. Reaching that takes an occurrence in every minute for 2 hours, every hour for 8 days, and every day after that, in every metric. A sparse series is a few buckets.
- The metric definition loses `max_retention_value`. The schema, `studio`, and the job change together.
- Changing a definition's function to `DISTINCT_COUNT` or `MEDIAN` starts its sketches empty. Earlier buckets have no sketch and count as empty for that function.
- The job backfills nothing. A new metric counts from the moment it goes `LIVE`, as before.

## Related

- [Customer decision](../components/customer-decision.md)
- [Profile writer](../components/profile-writer.md)
- [Identity merges](../components/identity/identity-merges.md)
- [0004. Compute metrics and decisions in one keyed job](0004-compute-metrics-and-decisions-in-one-keyed-job.md)
- [0005. Keep live state in Flink and a durable copy in Postgres](0005-keep-live-state-in-flink.md)
- Apache DataSketches, [HLL sketch](https://datasketches.apache.org/docs/HLL/HLL.html) and [KLL sketch](https://datasketches.apache.org/docs/KLL/KLLSketch.html)
