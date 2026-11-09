---
name: pull-request
description: Open, update, ready, and review GitHub pull requests for this repo with the bundled script, which reads the repo from origin and the token from the git credential cache. It is the PR tool for poteto mode's Opening a PR playbook in this repo: finding the issue a change fixes, opening a PR from the body template (Purpose and Diagram, then poteto mode's sections), updating it, and posting a review. Use whenever an agent pushes a branch for review, opens or edits a PR, or reviews one.
compatibility: Requires git and Python 3, a GitHub origin remote, and a GitHub token in the git credential cache.
allowed-tools: Bash(python3 .agents/skills/pull-request/scripts/pr.py:*) Bash(git push -u origin:*)
metadata:
  version: "1.0"
---

# Pull request

Poteto mode's Opening a PR playbook says what a PR contains; this skill is the tool that creates and edits it in this repo. Every PR is opened, updated, and reviewed through `scripts/pr.py`. Run it from the root of the worktree that holds the branch, as `python3 .agents/skills/pull-request/scripts/pr.py <command>`. Run each call as its own command. `python3 .agents/skills/pull-request/scripts/pr.py --help` lists the commands.

## Open a PR

1. Find the issue: `pr.py issues "<known-issue id or a phrase from the goal>"`. Pick the open issue that names the change's known-issue id or covers its goal. Do not create one.
2. Copy [assets/pr-body.md](assets/pr-body.md) to `.pm/pr-body.md`. Write Purpose and Diagram for a reader who does not know the code, the other sections as poteto mode's Opening a PR says, and end with `Closes #N`, `Refs #N`, or "No issue tracks this."
3. Push: `git push -u origin <branch>`. Never force-push.
4. Open it: `pr.py create --title "<type(scope): subject>" --body-file .pm/pr-body.md`. It prints the PR's number and URL.

## Update a PR

- New commits: push to the same branch.
- Body: edit `.pm/pr-body.md`, then `pr.py edit <number> --body-file .pm/pr-body.md`.
- Out of draft, if one was opened as a draft: `pr.py ready <number>`.
- State, head, and whether it merged: `pr.py view <number>`.

## Review a PR

1. Write the review body to `.pm/review.md`: the findings, each with file and line, what is wrong, the failure it causes, the fix, and blocking or non-blocking. End with one line, `Verdict: approve <head sha>` or `Verdict: changes requested <head sha>`.
2. For findings on lines inside the diff, write `.pm/review-comments.json`: a list of `{"path": "<file>", "line": <n>, "body": "<finding>"}`. Findings on other lines stay in the body.
3. Post: `pr.py review <number> --body-file .pm/review.md [--comments-file .pm/review-comments.json]`.

Reviews post as comments with the verdict line in the body. The team's agents share one GitHub account, and GitHub does not let an account approve its own PR.

Answer a review comment with `pr.py reply <number> <comment-id> --body-file <file>`.

## When a call fails

| Exit | Meaning | What to do |
|---|---|---|
| 1 | GitHub refused the call | Read the message. Fix the input, or report it. |
| 2 | Usage or local error | Check the command and that you are in the worktree. |
| 3 | No token in the credential cache | Stop and ask the user to log in again. |

Never merge, delete a branch, or close an issue with this skill. Those need the user's ask.
