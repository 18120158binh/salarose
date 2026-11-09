"""Fails when a test reads a repo file that its pr-checks job's path filter does not cover.

A job skipped by its filter reports success, so an uncovered input lets a change break the job's
tests without running them. Recognizes the three ways the tests build repo paths:
  Python:     Path(__file__).parents[N] / "a" / "b"
  Java:       Path.of("..", "a", "b")          (Maven runs tests from event-processor/)
  TypeScript: path.join(__dirname, "..", "a")
"""

import re
import sys
from fnmatch import fnmatch
from pathlib import Path, PurePosixPath

import yaml

REPO = Path(__file__).resolve().parents[2]
WORKFLOW = REPO / ".github" / "workflows" / "pr-checks.yml"

JOB_TESTS = {
    "event-processor": ("event-processor/src/test", "*.java"),
    "studio": ("studio", "*.test.ts*"),
    "pull-request-tool": (".agents/skills/pull-request/scripts", "test_*.py"),
    "simulator": ("simulator/tests", "test_*.py"),
    "db-migrations": ("infra/db", "test-*.sh"),
}

PARTS = r'((?:\s*,\s*"[^"]+")+)'
PATTERNS = [
    (re.compile(r'Path\(__file__\)\.parents\[(\d+)\]((?:\s*/\s*"[^"]+")+)'), "python"),
    (re.compile(r'Path\.of\(\s*"\.\."' + PARTS + r"\s*\)"), "java"),
    (re.compile(r"path\.(?:join|resolve)\(\s*__dirname" + PARTS + r"\s*\)"), "ts"),
]


def strings(text):
    return re.findall(r'"([^"]+)"', text)


def reads(test):
    text = test.read_text(encoding="utf-8")
    for pattern, kind in PATTERNS:
        for match in pattern.finditer(text):
            if kind == "python":
                yield test.parents[int(match.group(1))].joinpath(*strings(match.group(2)))
            elif kind == "java":
                yield (REPO / "event-processor" / "..").joinpath(*strings(match.group(1)))
            else:
                yield test.parent.joinpath(*strings(match.group(1)))


def main():
    workflow = yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))
    filter_step = next(step for step in workflow["jobs"]["changes"]["steps"] if step.get("id") == "filter")
    filters = yaml.safe_load(filter_step["with"]["filters"])
    assert set(filters) == set(JOB_TESTS), f"filters {sorted(filters)} != jobs {sorted(JOB_TESTS)}"

    found, errors = 0, []
    for job, (folder, glob) in JOB_TESTS.items():
        for test in (REPO / folder).rglob(glob):
            if "node_modules" in test.parts:
                continue
            for target in reads(test):
                found += 1
                rel = PurePosixPath(target.resolve().relative_to(REPO).as_posix())
                where = test.relative_to(REPO).as_posix()
                if not target.exists():
                    errors.append(f"{where} reads {rel}, which does not exist")
                elif not any(fnmatch(str(rel), pattern) for pattern in filters[job]):
                    errors.append(f"{where} reads {rel}, which the '{job}' filter does not cover")
    print(f"checked {found} repo paths read by tests")
    for error in errors:
        print(error, file=sys.stderr)
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
