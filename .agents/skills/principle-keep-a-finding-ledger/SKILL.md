---
name: principle-keep-a-finding-ledger
description: "Apply during any investigation that spans more than one pass, worker, or session. Keep a concise finding ledger that links each conclusion to evidence ids, its confidence and evidence type, the search boundary, and what is still unknown, and update the shared index or report so later passes reuse it."
disable-model-invocation: true
---

# Keep a Finding Ledger

Keep one short ledger per investigation. Each conclusion is a row that says what backs it and how far the search went.

**Why:** Findings held only in context are lost at the next compaction, the next worker, or the next session, and the work is done again. A conclusion without its boundary reads as "never happens" when it means "not in the two folders I searched".

Give each piece of evidence an id, and each conclusion a row:

```markdown
## Evidence
| Id | Source | What it shows |
|---|---|---|
| E1 | `MetricSink.java:120-148` | The sink upserts on (canon_id, metric_id) |
| E2 | `schema.sql:310` | No unique constraint on (canon_id, metric_id) |

## Findings
| # | Conclusion | Evidence | Confidence, type | Searched | Unknown |
|---|---|---|---|---|---|
| F1 | A replayed event can write a second metric row | E1, E2 | high, static | the sink and the schema | whether production has duplicates |
```

- **Every conclusion cites evidence ids.** No id, no conclusion. Write it under Unknown instead.
- **State the confidence and the evidence type** (static, test, runtime, owner's word), as [Corroborate with the Right Evidence](../principle-corroborate-with-the-right-evidence/SKILL.md) defines them.
- **State the search boundary:** what you searched and what you did not. "Not found" means nothing without it.
- **Keep the unknowns.** An open question stays in the ledger until it is answered or the owner closes it.
- **Keep it concise.** One line per row. Link to long output instead of pasting it.
- **Update the shared record** when the investigation has one: the investigation report, the index other passes read, a known-issues entry, or the card's ledger. Later passes and other workers start from it.

You skipped this when a later pass re-searched something already settled, or when a conclusion in the report cannot be traced to a file, a line, a command, or a person.

Distinct from [Decompose into Independent Questions](../principle-decompose-into-independent-questions/SKILL.md), which feeds workers' returns into this ledger.
