---
name: principle-question-driven-investigation
description: "Apply at the start of any investigation: a bug report, a \"how does X work\", a requirement, a review, or a user's question. Turn the request into a checklist of questions and the evidence each answer needs before you read code or run anything."
disable-model-invocation: true
---

# Question-Driven Investigation

Before you search, read the request in full: the user's words, the requirement, the issue, the contract, and any question they asked. Turn it into a checklist of questions. Next to each question, write the evidence that would answer it.

**Why:** A request read once and then searched for drifts toward whatever the first file shows. You answer the question you found, not the one you were asked, and you cannot tell when you are done.

- **One question per line, answerable with yes, no, a value, or a location.** "Does a replayed `purchase` event add to the metric twice?" is a question. "Look at metrics" is not.
- **Name the evidence each answer needs** before you look: a code path, a config value, a test result, a log line, a row in a table, a contract requirement. The evidence type decides where you look and how you corroborate it ([Corroborate with the Right Evidence](../principle-corroborate-with-the-right-evidence/SKILL.md)).
- **Include the questions the request implies but does not ask:** which version, which environment, which user, which input. If one of them changes the answer and you cannot find it, ask the user.
- **Work the checklist, not the codebase.** Tick a question only when its evidence is in hand. A new question found on the way goes on the list; it does not replace the list.
- **Answer every question, or say it is open.** The report lists each question with its answer and evidence, or with what is still unknown.

You skipped this when you started reading code before you could say what would count as an answer, or when your report answers questions nobody asked and skips one that was.

Distinct from [Decompose into Independent Questions](../principle-decompose-into-independent-questions/SKILL.md), which splits the checklist into scopes you can work in parallel.
