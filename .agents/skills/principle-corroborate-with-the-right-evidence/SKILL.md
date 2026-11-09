---
name: principle-corroborate-with-the-right-evidence
description: "Apply before you state a conclusion from an investigation. Back it with the type of evidence the claim requires: code and config for what the program does, a test for what it does on an input, runtime observation only when static evidence cannot answer and the host runtime is available."
disable-model-invocation: true
---

# Corroborate with the Right Evidence

Every conclusion is a claim of a certain type, and each type needs its own evidence. Match the two before you state it.

**Why:** The wrong kind of evidence feels as strong as the right kind. A comment says what someone meant, not what the code does. A passing unit test does not show what production saw. A log line from one run does not show every run.

| Claim | Evidence it requires |
|---|---|
| The code can do X, or never does X | The code path, read end to end, with the config and resources it reads |
| It does X on this input | A test or a script that runs it on that input, with its output |
| It did X in that environment, at that time | Runtime observation: logs, metrics, rows, traces from that environment |
| It is meant to do X | The contract, the decision record, or the owner's words |
| X is the cause | The above, plus a check that removing the cause removes the effect |

- **Prefer static evidence.** Read the code, the config, and the tests first. They are cheap, repeatable, and safe.
- **Use runtime observation only when static evidence cannot answer**, such as a timing, a value that exists only in the environment, or a claim about what already happened, **and only when the host runtime the question needs is available and you are allowed to use it.** If it is not, say the claim is unverified and what observation would settle it. Do not start a local stand-in and call it the host.
- **Two independent sources beat one.** When the claim matters, find a second kind of evidence that agrees: the code and a test, a log and a row.
- **State the evidence type with the conclusion**, so the reader knows how far to trust it.

You skipped this when a conclusion rests on a comment, a name, a single log line, or "it should", or when you ran something to answer a question the code already answered.

Distinct from [Prove It Works](https://github.com/backnotprop/pstack/blob/main/skills/principle-prove-it-works/SKILL.md), which checks your own output. This principle checks a claim about a system you are investigating.
