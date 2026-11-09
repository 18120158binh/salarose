---
title: Business event fan-out known issues
contract: ../../architecture/components/business-event-fan-out.md
updated: 2026-10-21
verified_at: 1e59e806
---

# Business event fan-out known issues

Business event fan-out is not built. No job keeps an interest or segment member index, and no topic carries business events or matches. The builder offers `price_drop` and `back_in_stock` as triggers, but nothing produces them, as [use cases](../../product/use-cases.md) UC-08 and UC-14 record.

| Id | Severity | Issue | Breaks |
|---|---|---|---|
