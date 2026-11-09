#!/usr/bin/env python3
"""Open, update, and review GitHub pull requests for the repo in the current directory.

Usage:
  pr.py issues <text>                                  open issues whose title or body has <text>
  pr.py create --title T --body-file F [--base B] [--draft]
                                                       open a PR from the current branch
  pr.py view [<number>]                                the PR's state, head, and mergeability
  pr.py edit <number> --body-file F                    replace the PR body
  pr.py ready <number>                                 take the PR out of draft
  pr.py review <number> --body-file F [--comments-file C]
                                                       post a review on the PR's head
  pr.py reply <number> <comment-id> --body-file F      reply to a review comment

The repository comes from the `origin` remote. The token comes from the git credential cache for
github.com and is never printed. Push the branch with `git push -u origin <branch>` before `create`.
A redirect from GitHub, such as after the repository is renamed, is followed with the same method
and body.

Reviews are posted with the COMMENT event: the team's agents share one GitHub account with the PR's
author, and GitHub rejects APPROVE and REQUEST_CHANGES on your own PR. The verdict goes in the body.

A comments file is a JSON list of {"path": ..., "line": N, "body": ...} on lines inside the diff.

Exit codes: 0 done, 1 GitHub refused the call, 2 usage error, 3 no token in the credential cache.
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
# GitHub answers a renamed or moved repository with a redirect and expects the request repeated
# verbatim, so every method is re-sent with its body. A redirect must keep the API's scheme, https.
# The token goes only to the API's own origin, and once a redirect leaves it, never again in that call.
REDIRECTS = {301, 302, 307, 308}
MAX_REDIRECTS = 5


class GitHubError(Exception):
    pass


def git(*args):
    return subprocess.run(
        ["git", *args], capture_output=True, text=True, check=True
    ).stdout.strip()


def parse_repo(url):
    """Return "owner/name" from an https or ssh GitHub remote URL."""
    match = re.search(r"github\.com[:/]([^/]+)/([^/]+?)(?:\.git)?/?$", url)
    if not match:
        raise GitHubError(f"origin is not a GitHub repository: {url}")
    return f"{match.group(1)}/{match.group(2)}"


def token():
    out = subprocess.run(
        ["git", "credential", "fill"],
        input="protocol=https\nhost=github.com\n\n",
        capture_output=True,
        text=True,
        check=False,
        env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
    ).stdout
    for line in out.splitlines():
        if line.startswith("password="):
            return line.removeprefix("password=")
    print(
        "No GitHub token in the git credential cache. Ask the user to log in again, "
        "for example by running a `git push` in their own terminal.",
        file=sys.stderr,
    )
    sys.exit(3)


def opener(scheme_handler):
    """An opener for one scheme that hands every 3xx back to `call` as an HTTPError.

    `build_opener` would also add file, data, and ftp handlers and urllib's own redirect handler,
    which re-sends only GET and drops a POST body.
    """
    director = urllib.request.OpenerDirector()
    for handler in (
        urllib.request.ProxyHandler(),
        scheme_handler,
        urllib.request.UnknownHandler(),
        urllib.request.HTTPDefaultErrorHandler(),
        urllib.request.HTTPErrorProcessor(),
    ):
        director.add_handler(handler)
    return director


OPENER = opener(urllib.request.HTTPSHandler())


def origin(url):
    parts = urllib.parse.urlsplit(url)
    return parts.scheme, parts.netloc


def call(method, path, body=None):
    url = path if path.startswith("https://") else f"{API}/{path}"
    data = None if body is None else json.dumps(body).encode()
    auth = f"Bearer {token()}"
    on_api = True
    for _ in range(MAX_REDIRECTS + 1):
        on_api = on_api and origin(url) == origin(API)
        headers = {"Accept": "application/vnd.github+json"}
        if on_api:
            headers["Authorization"] = auth
        request = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            with OPENER.open(request) as response:
                raw = response.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as err:
            text = err.read().decode()
            if err.code not in REDIRECTS:
                raise GitHubError(f"{method} {path}: HTTP {err.code} {text[:400]}") from None
            location = err.headers.get("Location")
            if not location:
                raise GitHubError(f"{method} {path}: HTTP {err.code} without a Location") from None
            url = urllib.parse.urljoin(url, location)
            scheme = urllib.parse.urlsplit(url).scheme
            if scheme != urllib.parse.urlsplit(API).scheme:
                raise GitHubError(
                    f"{method} {path}: HTTP {err.code} redirects to a {scheme} URL, refused"
                ) from None
    raise GitHubError(f"{method} {path}: more than {MAX_REDIRECTS} redirects")


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def summary(pr):
    return {
        "number": pr["number"],
        "url": pr["html_url"],
        "state": pr["state"],
        "draft": pr["draft"],
        "merged": pr.get("merged"),
        "merge_commit": pr.get("merge_commit_sha"),
        "head": pr["head"]["sha"],
        "branch": pr["head"]["ref"],
        "base": pr["base"]["ref"],
        "mergeable_state": pr.get("mergeable_state"),
    }


def run(args, repo):
    base = f"repos/{repo}"
    if args.command == "issues":
        found = call("GET", f"search/issues?q=repo:{repo}+is:issue+is:open+{args.text}")
        return [
            {"number": i["number"], "title": i["title"], "url": i["html_url"]}
            for i in found["items"]
        ]
    if args.command == "create":
        target = args.base or call("GET", base)["default_branch"]
        pr = call(
            "POST",
            f"{base}/pulls",
            {
                "head": git("rev-parse", "--abbrev-ref", "HEAD"),
                "base": target,
                "title": args.title,
                "body": read(args.body_file),
                "draft": args.draft,
            },
        )
        return summary(pr)
    if args.command == "view":
        number = (
            args.number
            or call(
                "GET",
                f"{base}/pulls?head={repo.split('/')[0]}:{git('rev-parse', '--abbrev-ref', 'HEAD')}",
            )[0]["number"]
        )
        return summary(call("GET", f"{base}/pulls/{number}"))
    if args.command == "edit":
        return summary(
            call("PATCH", f"{base}/pulls/{args.number}", {"body": read(args.body_file)})
        )
    if args.command == "ready":
        node = call("GET", f"{base}/pulls/{args.number}")["node_id"]
        query = "mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { number isDraft } } }"
        return call(
            "POST", f"{API}/graphql", {"query": query, "variables": {"id": node}}
        )["data"]
    if args.command == "review":
        head = call("GET", f"{base}/pulls/{args.number}")["head"]["sha"]
        body = {"commit_id": head, "event": "COMMENT", "body": read(args.body_file)}
        if args.comments_file:
            body["comments"] = [
                {"side": "RIGHT", **c} for c in json.loads(read(args.comments_file))
            ]
        review = call("POST", f"{base}/pulls/{args.number}/reviews", body)
        return {
            "id": review["id"],
            "url": review["html_url"],
            "commit": review["commit_id"],
        }
    if args.command == "reply":
        reply = call(
            "POST",
            f"{base}/pulls/{args.number}/comments/{args.comment_id}/replies",
            {"body": read(args.body_file)},
        )
        return {"id": reply["id"], "url": reply["html_url"]}
    raise GitHubError(f"Unknown command: {args.command}")


def parser():
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = p.add_subparsers(dest="command", required=True)
    sub.add_parser("issues").add_argument("text")
    create = sub.add_parser("create")
    create.add_argument("--title", required=True)
    create.add_argument("--body-file", required=True)
    create.add_argument("--base")
    create.add_argument("--draft", action="store_true")
    sub.add_parser("view").add_argument("number", nargs="?", type=int)
    edit = sub.add_parser("edit")
    edit.add_argument("number", type=int)
    edit.add_argument("--body-file", required=True)
    sub.add_parser("ready").add_argument("number", type=int)
    review = sub.add_parser("review")
    review.add_argument("number", type=int)
    review.add_argument("--body-file", required=True)
    review.add_argument("--comments-file")
    reply = sub.add_parser("reply")
    reply.add_argument("number", type=int)
    reply.add_argument("comment_id", type=int)
    reply.add_argument("--body-file", required=True)
    return p


def main():
    args = parser().parse_args()
    try:
        repo = parse_repo(git("remote", "get-url", "origin"))
        print(json.dumps(run(args, repo), indent=2))
    except GitHubError as err:
        print(err, file=sys.stderr)
        sys.exit(1)
    except (OSError, subprocess.CalledProcessError, KeyError, IndexError) as err:
        print(f"error: {err}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
