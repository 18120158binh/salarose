#!/usr/bin/env python3
"""File the entries in docs/internal/known-issues/ as GitHub issues.

One issue per Blocking, Wrong result, and Risk entry. One checklist issue per
page for its Minor entries. An entry marked "Same defect as XX-KI-nn" is not
filed, because its twin is. Entries that already have an issue, matched by the
known-issues id at the start of the title, are skipped. Dry-run by default.
With --apply it creates the labels and the issues, then writes "Tracked in #N."
into each entry, so commit the pages afterwards.

The token comes from GITHUB_TOKEN, GH_TOKEN, or the git credential for
github.com, as in github_issue.py. Run it where `git push` works without a
prompt.

Usage:
    file_known_issues.py                      # dry run: prints what it would file
    file_known_issues.py --page customer-decision
    file_known_issues.py --apply
"""

import argparse
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import github_issue as gh

ROOT = Path(__file__).resolve().parents[4]
PAGES = ROOT / "docs" / "internal" / "known-issues"
BRANCH = "master"
STUDIO_PAGES = {
    "journey-builder",
    "campaign-management",
    "ai-journey-generation",
    "event-catalog",
    "admin-authentication",
    "segments",
}
SEVERITY_LABEL = {
    "Blocking": "severity:blocking",
    "Wrong result": "severity:wrong-result",
    "Risk": "severity:risk",
    "Minor": "severity:minor",
}
ROW = re.compile(
    r"^\|\s*([A-Z]+-KI-\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|\s*$"
)
SECTION = re.compile(r"^## ([A-Z]+-KI-\d+)\. (.+)$")
TRACKED = re.compile(r"Tracked in #\d+\.")
SAME_AS = re.compile(r"\*\*Same defect as ([A-Z]+-KI-\d+)\.\*\*")


def slug(heading: str) -> str:
    text = re.sub(r"[^\w\- ]", "", heading.strip().lower())
    return text.replace(" ", "-")


def area(page: str) -> str:
    if page == "platform":
        return "area:infra"
    return "area:studio" if page in STUDIO_PAGES else "area:event-processor"


def parse_page(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    title = re.search(r"^title:\s*(.+)$", text, re.MULTILINE).group(1).strip()
    contract = re.search(r"^contract:\s*(.+)$", text, re.MULTILINE).group(1).strip()
    rows = {m.group(1): m.groups() for m in map(ROW.match, text.splitlines()) if m}
    sections, current = {}, None
    for line in text.splitlines():
        match = SECTION.match(line)
        if match:
            current = match.group(1)
            sections[current] = {"heading": line[3:], "body": []}
        elif line.startswith("## "):
            current = None
        elif current:
            sections[current]["body"].append(line)
    entries = []
    for ki, (_, severity, issue, breaks) in rows.items():
        section = sections.get(ki, {"heading": f"{ki}. {issue}", "body": []})
        entries.append(
            {
                "id": ki,
                "severity": severity,
                "title": issue.replace("`", ""),
                "breaks": breaks,
                "anchor": slug(section["heading"]),
                "body": "\n".join(section["body"]).strip(),
            }
        )
    return {
        "name": path.stem,
        "rel": path.relative_to(ROOT).as_posix(),
        "title": title.removesuffix(" known issues"),
        "contract": (path.parent / contract).resolve().relative_to(ROOT).as_posix(),
        "entries": entries,
    }


def blob(slug_: str, rel: str) -> str:
    return f"https://github.com/{slug_}/blob/{BRANCH}/{rel}"


def entry_issue(repo: str, page: dict, entry: dict) -> dict:
    page_rel = page["rel"]
    contract_rel = page["contract"]
    lines = [f"<!-- known-issue: {entry['id']} -->", "", "## Summary", ""]
    summary = re.search(r"\*\*Symptom\.\*\*\s*(.+)", entry["body"]) or re.search(
        r"\*\*Cause\.\*\*\s*(.+)", entry["body"]
    )
    lines.append(summary.group(1).strip() if summary else entry["title"] + ".")
    lines += ["", "## Contract", ""]
    breaks = [
        b.strip()
        for b in entry["breaks"].split(",")
        if re.match(r"^[A-Z]+-N?FR-\d+$", b.strip())
    ]
    for requirement in breaks:
        lines.append(
            f"- Breaks: `{requirement}` in [{page['title']}]({blob(repo, contract_rel)})"
        )
    if not breaks and entry["breaks"]:
        lines.append(
            f"- Related: {entry['breaks']} in [{page['title']}]({blob(repo, contract_rel)})"
        )
    lines.append(
        f"- Known issue: [{entry['id']}]({blob(repo, page_rel)}#{entry['anchor']})"
    )
    lines += [
        "",
        "## Details",
        "",
        entry["body"] or "See the known-issues entry.",
        "",
        "## Acceptance criteria",
        "",
    ]
    if breaks:
        lines.append(f"- [ ] The code meets {', '.join(f'`{b}`' for b in breaks)}.")
    else:
        lines.append("- [ ] The defect described above no longer occurs.")
    lines += [
        "- [ ] A test covers the case.",
        f"- [ ] The entry {entry['id']} is deleted from `{page_rel}`.",
    ]
    labels = [
        "bug",
        area(page["name"]),
        SEVERITY_LABEL.get(entry["severity"], "severity:risk"),
    ]
    return {
        "key": entry["id"],
        "title": f"{entry['id']}: {entry['title']}",
        "body": "\n".join(lines),
        "labels": labels,
        "entries": [entry["id"]],
    }


def minor_issue(repo: str, page: dict, minors: list) -> dict:
    page_rel = page["rel"]
    lines = [
        f"<!-- known-issue-group: {page['name']} -->",
        "",
        "## Summary",
        "",
        (
            f"Minor known issues in {page['title']}: cosmetic problems, dead code, and missing tests. "
            "Each item can be fixed on its own. Tick it and delete its entry from the page when it lands."
        ),
        "",
        "## Items",
        "",
    ]
    lines += [
        f"- [ ] [{e['id']}]({blob(repo, page_rel)}#{e['anchor']}): {e['title']}"
        for e in minors
    ]
    title = f"{page['title']}: minor known issues"
    labels = ["chore", area(page["name"]), "severity:minor"]
    return {
        "key": f"group:{page['name']}",
        "title": title,
        "body": "\n".join(lines),
        "labels": labels,
        "entries": [e["id"] for e in minors],
    }


def existing_titles(repo: str) -> list:
    titles, page = [], 1
    while True:
        batch = gh.call(
            "GET", f"/repos/{repo}/issues?state=all&per_page=100&page={page}"
        )
        titles += [item["title"] for item in batch if "pull_request" not in item]
        if len(batch) < 100:
            return titles
        page += 1


def already_filed(issue: dict, titles: list) -> bool:
    if issue["key"].startswith("group:"):
        return issue["title"] in titles
    return any(t.startswith(issue["key"] + ":") for t in titles)


def page_path(page_name: str) -> Path:
    # Pages live in features/, components/, and their subfolders. Stems are unique.
    return next(PAGES.rglob(f"{page_name}.md"))


def write_back(page_name: str, entry_ids: list, number: int) -> None:
    path = page_path(page_name)
    lines = path.read_text(encoding="utf-8").splitlines()
    out, current = [], None
    for index, line in enumerate(lines):
        match = SECTION.match(line)
        if match:
            current = match.group(1)
        out.append(line)
        ends_section = index + 1 == len(lines) or lines[index + 1].startswith("## ")
        if current in entry_ids and ends_section:
            while out and not out[-1].strip():
                out.pop()
            if not TRACKED.search(out[-1]):
                out += ["", f"Tracked in #{number}."]
            out.append("")
            current = None
    path.write_text("\n".join(out).rstrip("\n") + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--page", action="append", help="Only these pages, by file stem"
    )
    parser.add_argument(
        "--apply", action="store_true", help="Create labels and issues, and write back"
    )
    parser.add_argument(
        "--pause", type=float, default=2.0, help="Seconds between creates"
    )
    args = parser.parse_args()

    repo = gh.repo_slug()
    paths = sorted(p for p in PAGES.rglob("*.md") if p.name != "README.md")
    if args.page:
        paths = [p for p in paths if p.stem in args.page]
    issues, skipped = [], []
    for path in paths:
        page = parse_page(path)
        dupes = [e for e in page["entries"] if SAME_AS.search(e["body"])]
        skipped += [(e["id"], SAME_AS.search(e["body"]).group(1)) for e in dupes]
        page["entries"] = [e for e in page["entries"] if e not in dupes]
        minors = [e for e in page["entries"] if e["severity"] == "Minor"]
        issues += [
            (page["name"], entry_issue(repo, page, e))
            for e in page["entries"]
            if e["severity"] != "Minor"
        ]
        if minors:
            issues.append((page["name"], minor_issue(repo, page, minors)))

    try:
        titles = existing_titles(repo)
    except SystemExit as error:
        if args.apply:
            raise
        print(f"WARNING: no duplicate check. {error}")
        titles = []
    todo = [(name, issue) for name, issue in issues if not already_filed(issue, titles)]
    print(
        f"{len(issues)} issues from {len(paths)} pages. {len(issues) - len(todo)} already filed. {len(todo)} to file."
    )
    for ki, target in skipped:
        print(f"  skip {ki}: same defect as {target}")
    for name, issue in todo:
        print(f"  {name:24} {', '.join(issue['labels']):55} {issue['title']}")
    if not args.apply:
        print("Dry run. Nothing was sent. Re-run with --apply to file them.")
        return

    gh.cmd_ensure_labels(argparse.Namespace(apply=True))
    for name, issue in todo:
        created = gh.call(
            "POST",
            f"/repos/{repo}/issues",
            {k: issue[k] for k in ("title", "body", "labels")},
        )
        applied = {label["name"] for label in created.get("labels", [])}
        missing = sorted(set(issue["labels"]) - applied)
        note = f" (labels not applied: {missing})" if missing else ""
        print(f"created #{created['number']} {created['html_url']}{note}")
        write_back(name, issue["entries"], created["number"])
        time.sleep(args.pause)
    print("Done. Commit the updated pages in docs/internal/known-issues/.")


if __name__ == "__main__":
    main()
