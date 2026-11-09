---
title: Home overview known issues
contract: ../../features/home-overview.md
updated: 2026-11-08
verified_at: feat/v2-home, before deploy
---

# Home overview known issues

## HOM-NFR-01 is not measured yet

Breaks HOM-NFR-01. Each region's reads run in one read-only transaction with a 5-second statement timeout, and every statement reads one node type so that the indexes of decision 0035 apply. Nobody has timed Last 30 days on the deployed database yet. Phase 1 verification (V2-19) measures it, and records the result of decision 0035's check if a region misses 2 seconds. The reads live in `studio/src/features/home-overview/model/queries.ts`.

## The health strip says "Last transition"

Breaks HOM-FR-08. The contract renamed the health strip's third item to "Last journey step" on 2026-11-08. `studio/src/features/home-overview/ui/HealthStrip.tsx` still renders "Last transition" (line 66). Change the label and its test.
