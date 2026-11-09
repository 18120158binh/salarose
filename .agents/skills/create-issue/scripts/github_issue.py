#!/usr/bin/env python3
"""Search, create, and comment on GitHub issues for this repo.

Dry-run by default: every write prints the request and sends nothing until
``--apply`` is given. The token comes from ``GITHUB_TOKEN`` or ``GH_TOKEN``,
or else from the git credential helper for github.com. It is never printed
and never passed in argv.

Usage:
    github_issue.py search "KI-01 branch names"
    github_issue.py create --title "..." --body-file body.md --label bug [--apply]
    github_issue.py comment --number 12 --body-file note.md [--apply]
    github_issue.py ensure-labels [--apply]
"""

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

API = "https://api.github.com"

# Labels this repo's issues use. ensure-labels creates the missing ones.
LABELS = {
    "bug": ("d73a4a", "The code departs from a contract"),
    "enhancement": ("a2eeef", "A new or changed requirement"),
    "decision": ("5319e7", "An open question in a contract that needs a decision"),
    "docs": ("0075ca", "Documentation only"),
    "chore": ("cfd3d7", "Build, CI, dependencies, or tooling"),
    "area:event-processor": ("1d76db", "The Flink jobs"),
    "area:studio": ("1d76db", "The Next.js app"),
    "area:infra": ("1d76db", "Schema, compose, deployment"),
    "severity:blocking": ("b60205", "The feature does not work end to end"),
    "severity:wrong-result": (
        "d93f0b",
        "The feature produces output the contract forbids",
    ),
    "severity:risk": (
        "fbca04",
        "Fails under a condition that can happen in production",
    ),
    "severity:minor": ("c2e0c6", "Cosmetic, dead code, or missing tests"),
    "agent-ready": (
        "0e8a16",
        "Concrete acceptance criteria. A coding agent can pick it up.",
    ),
}


def repo_slug() -> str:
    url = subprocess.run(
        ["git", "remote", "get-url", "origin"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    match = re.search(r"github\.com[:/]([^/]+/[^/]+?)(?:\.git)?$", url)
    if not match:
        sys.exit(f"origin is not a GitHub remote: {url}")
    return match.group(1)


def token() -> str:
    for name in ("GITHUB_TOKEN", "GH_TOKEN"):
        if os.environ.get(name):
            return os.environ[name]
    result = subprocess.run(
        ["git", "credential", "fill"],
        input="protocol=https\nhost=github.com\n\n",
        capture_output=True,
        text=True,
        env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
        check=False,
    )
    for line in result.stdout.splitlines():
        if line.startswith("password="):
            return line.removeprefix("password=")
    sys.exit(
        "No GitHub token. Set GITHUB_TOKEN (fine-grained, Issues: read and write), "
        "or sign in to github.com with git so the credential helper has one."
    )


def call(method: str, path: str, payload: dict | None = None) -> dict | list:
    request = urllib.request.Request(
        f"{API}{path}",
        method=method,
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token()}",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "cdp-journey-engine-create-issue",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            body = response.read()
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors="replace")[:500]
        sys.exit(f"GitHub API {method} {path} failed: {error.code} {detail}")


def preview(method: str, path: str, payload: dict) -> None:
    print(f"DRY RUN: {method} {API}{path}")
    print(json.dumps(payload, indent=2, ensure_ascii=False))
    print("Nothing was sent. Re-run with --apply to send it.")


def cmd_search(args: argparse.Namespace) -> None:
    query = f"repo:{repo_slug()} is:issue {args.query}"
    result = call("GET", f"/search/issues?q={urllib.parse.quote(query)}&per_page=20")
    items = result.get("items", [])
    if not items:
        print("No matching issues.")
    for item in items:
        print(
            f"#{item['number']}\t{item['state']}\t{item['title']}\t{item['html_url']}"
        )


def cmd_create(args: argparse.Namespace) -> None:
    with open(args.body_file, encoding="utf-8") as handle:
        body = handle.read()
    unknown = [label for label in args.label if label not in LABELS]
    if unknown:
        sys.exit(f"Unknown labels {unknown}. Use one of: {', '.join(LABELS)}")
    payload = {"title": args.title, "body": body, "labels": args.label}
    path = f"/repos/{repo_slug()}/issues"
    if not args.apply:
        preview("POST", path, payload)
        return
    issue = call("POST", path, payload)
    print(f"created #{issue['number']} {issue['html_url']}")
    # GitHub drops labels silently when the token has no push access to the repo.
    applied = {label["name"] for label in issue.get("labels", [])}
    dropped = sorted(set(args.label) - applied)
    if dropped:
        print(
            f"WARNING: GitHub did not apply labels {dropped}. Run ensure-labels, or use a token with push access."
        )


def cmd_comment(args: argparse.Namespace) -> None:
    with open(args.body_file, encoding="utf-8") as handle:
        payload = {"body": handle.read()}
    path = f"/repos/{repo_slug()}/issues/{args.number}/comments"
    if not args.apply:
        preview("POST", path, payload)
        return
    comment = call("POST", path, payload)
    print(f"commented {comment['html_url']}")


def cmd_ensure_labels(args: argparse.Namespace) -> None:
    slug = repo_slug()
    existing = {
        label["name"] for label in call("GET", f"/repos/{slug}/labels?per_page=100")
    }
    missing = [name for name in LABELS if name not in existing]
    if not missing:
        print("All labels exist.")
        return
    for name in missing:
        color, description = LABELS[name]
        payload = {"name": name, "color": color, "description": description}
        if args.apply:
            call("POST", f"/repos/{slug}/labels", payload)
            print(f"created label {name}")
        else:
            print(f"DRY RUN: would create label {name}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = parser.add_subparsers(dest="command", required=True)

    search = sub.add_parser(
        "search", help="Find open and closed issues that match a query"
    )
    search.add_argument("query")
    search.set_defaults(func=cmd_search)

    create = sub.add_parser("create", help="Create an issue")
    create.add_argument("--title", required=True)
    create.add_argument("--body-file", required=True)
    create.add_argument("--label", action="append", default=[])
    create.add_argument("--apply", action="store_true")
    create.set_defaults(func=cmd_create)

    comment = sub.add_parser("comment", help="Add a comment to an existing issue")
    comment.add_argument("--number", type=int, required=True)
    comment.add_argument("--body-file", required=True)
    comment.add_argument("--apply", action="store_true")
    comment.set_defaults(func=cmd_comment)

    labels = sub.add_parser("ensure-labels", help="Create the labels this repo uses")
    labels.add_argument("--apply", action="store_true")
    labels.set_defaults(func=cmd_ensure_labels)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
