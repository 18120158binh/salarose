---
name: principle-decompose-into-independent-questions
description: "Apply when an investigation has more than a few questions. Split it into independent questions; when parallel workers are available, give each a distinct scope, point it at existing evidence, and ask for sources, conclusions, and unresolved gaps. Otherwise work sequentially."
disable-model-invocation: true
---

# Decompose into Independent Questions

Split the question checklist into questions whose answers do not depend on one another. Work them in parallel when you can, and in order when you cannot.

**Why:** A worker given "figure out the outage" re-reads what you already read, overlaps with the next worker, and returns a story instead of an answer. A worker given one question, a scope, and the evidence so far returns a conclusion you can check.

- **Find the dependencies first.** If question B needs A's answer, B waits for A. Only questions with no edge between them run in parallel.
- **Use parallel workers only when they exist and the questions are independent.** Otherwise work sequentially, one question at a time, in dependency order. Do not simulate parallel work by interleaving.
- **Give each worker a distinct scope:** one question, the files, folders, tables, or services it covers, and what is out of scope. Two workers never search the same scope.
- **Point workers at existing evidence:** the finding ledger, the investigation report, the files and line numbers already found. A worker starts from what is known, not from zero.
- **Ask for the same return shape from every worker:** the sources it read (paths and lines, queries, commands), its conclusions with their evidence type, and the gaps it could not close. A worker's conclusion is a claim until you check its sources.
- **Merge into one ledger.** Fold each return into the [finding ledger](../principle-keep-a-finding-ledger/SKILL.md) and re-plan the open questions.

You skipped this when two workers returned the same finding, when a worker re-derived a fact already in the ledger, or when a worker's report has conclusions but no sources.

Distinct from [Question-Driven Investigation](../principle-question-driven-investigation/SKILL.md), which writes the questions. This principle schedules them.
