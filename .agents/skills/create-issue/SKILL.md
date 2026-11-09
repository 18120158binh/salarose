---
name: create-issue
description: >
  File one well-formed GitHub issue on this repo that a coding agent can pick
  up cold: a bug where the code breaks a contract, an open question
  that needs a decision, a new requirement, or a chore. Searches for
  duplicates first, ties the issue to the contract's requirement id and the
  known-issues entry, and is dry-run by default. Use when the user says
  "create an issue", "open a ticket", "file a bug", "report this", "track
  this", or "make an issue for DEC-KI-01". Not for fixing the problem, and not
  for issues in other repos.
---

# Create an issue

An issue here is a work order for a person or an agent who has not seen this conversation. It must say what is wrong or wanted, point at the contract that defines the right behavior, and give a check that proves the work is done. The docs already hold most of that: the contracts in `docs/internal/features/` and `docs/internal/architecture/components/` define behavior with requirement ids such as `DEC-FR-06`, and `docs/internal/known-issues/` records each defect with an id such as `DEC-KI-04`. An issue links them. It does not copy them.

Never create, edit, or comment on an issue without the user's yes in this conversation. Creating an issue publishes it.

## Steps

1. **Classify the request.**

	| Kind | When | Label |
	|---|---|---|
	| Bug | The code departs from a requirement in a contract | `bug` |
	| Decision | A contract's "Open questions" blocks the work | `decision` |
	| Enhancement | A new or changed requirement | `enhancement` |
	| Docs, Chore | Only docs, or build, CI, and tooling | `docs`, `chore` |

	Add one area label: `area:event-processor`, `area:studio`, or `area:infra`. A bug also gets the severity from its known-issues entry: `severity:blocking`, `severity:wrong-result`, `severity:risk`, or `severity:minor`.

2. **Find the contract and the evidence.**
	- Find the requirement id the bug breaks, in the feature's contract.
	- Find the known-issues entry. If none exists for a bug, write one first from [the template](../../../docs/internal/_templates/known-issues.md), in the contract's known-issues page. Give the cause with real class and file names, and mark anything you inferred but did not run.
	- For an enhancement, draft the requirement rows it adds or changes. The contract changes when the work lands, not when the issue is filed.
	- Never invent a stack trace, a log line, or a reproduction. If you have no evidence, say so in the issue.

3. **Search for duplicates.** Search by the known-issues id, which every bug issue carries in its title and in its "Known issue" link, and by two or three title words, across open and closed issues:

	```bash
	python3 .agents/skills/create-issue/scripts/github_issue.py search "DEC-KI-04"
	python3 .agents/skills/create-issue/scripts/github_issue.py search "metric snapshot in:title"
	```

	If an issue already covers it, don't file a second one. Offer to add a comment with the new evidence instead, with `comment --number N --body-file note.md`.

4. **Draft the issue.** Write the title and the body from [references/issue-template.md](references/issue-template.md) into a file in your scratchpad, not in the repo. Show the user the title, the labels, and the body.

5. **Create it, on the user's yes.** The first time on a repo, create the labels:

	```bash
	python3 .agents/skills/create-issue/scripts/github_issue.py ensure-labels            # dry run
	python3 .agents/skills/create-issue/scripts/github_issue.py ensure-labels --apply
	python3 .agents/skills/create-issue/scripts/github_issue.py create \
		--title "DEC-KI-04: metric conditions see only the metrics this event changed" \
		--body-file "$SCRATCH/issue.md" --label bug --label area:event-processor \
		--label severity:wrong-result            # dry run: prints the request
	# the same command with --apply sends it and prints the number and URL
	```

	Add `agent-ready` only when the acceptance criteria are concrete checks and the user agrees.

6. **Link back.** Add `Tracked in #N.` to the known-issues entry, and commit that edit with the user's other changes. A fix later deletes the entry and closes the issue with `Closes #N` in the commit or the pull request.

## File every known issue at once

When the user asks to file the known-issues pages as issues, use the batch filer instead of steps 3 to 6. It makes one issue per Blocking, Wrong result, and Risk entry, and one checklist issue per page for the Minor entries. It skips entries whose id already starts an issue title, and after `--apply` it writes `Tracked in #N.` into each entry.

```bash
python3 .agents/skills/create-issue/scripts/file_known_issues.py                 # dry run, lists every issue
python3 .agents/skills/create-issue/scripts/file_known_issues.py --page platform # one page
python3 .agents/skills/create-issue/scripts/file_known_issues.py --apply
```

Push the known-issues pages before you file. The issue bodies link to them on `master`. After `--apply`, commit the pages with the write-backs.

## Token

The script reads `GITHUB_TOKEN` or `GH_TOKEN`, or else the git credential for `github.com`. A fine-grained token needs Issues: read and write on this repo. A classic token needs `repo`, or `public_repo` for a public repo. The script never prints the token. Don't paste one into chat or argv. On a machine with `gh`, the same steps work with `gh issue list --search`, `gh issue create --body-file`, and `gh label create`.

## Rules

- One issue per problem. A known-issues entry maps to at most one open issue.
- The title says what is wrong, in the reader's words, and starts with the known-issues id when there is one.
- Link to contracts and known issues by path. Don't paste their text.
- No secrets, tokens, customer data, internal hostnames, or raw logs with personal data in an issue. Summarize, and say where the full evidence lives.
- Check the labels on the created issue. GitHub drops labels silently when the token has no push access. The script prints a warning when it happens.

## Summary

End with this table:

| | |
|---|---|
| skill | create-issue |
| kind / labels | bug / `bug`, `area:event-processor`, `severity:wrong-result` |
| duplicate check | none found |
| issue | #14 https://github.com/<owner>/<repo>/issues/14, or "dry run, not sent" |
| docs changed | `docs/internal/known-issues/components/customer-decision.md` (Tracked in #14) |
