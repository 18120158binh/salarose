---
title: Lakehouse sink known issues
contract: ../../architecture/components/lakehouse.md
updated: 2026-11-17
verified_at: a29730c
---

# Lakehouse sink known issues

No open issues. The lakehouse sink is not built. No job writes `raw_events` or `transition_history`, and no catalog exists. The gaps this leaves in other contracts are tracked there: [JEX-KI-38](journey-execution.md#jex-ki-38-user_campaign_state_transitions-is-one-unpartitioned-table-that-keeps-every-row-with-the-analytics-indexes), [REC-KI-05](state-recovery.md#rec-ki-05-no-copy-of-the-raw-events-outlives-kafkas-retention), [HOM-KI-01](../features/home-overview.md#hom-ki-01-the-kpi-row-and-the-journeys-table-read-the-hot-transitions-table-not-the-lakehouse), and [JBD-KI-37](../features/journey-builder.md#jbd-ki-37-journey-analytics-read-the-hot-transitions-table-not-the-lakehouse).
