"""Clean-up (SIM-FR-14): the rows a run's shoppers created, and on request the `sim_` fixtures, and nothing else.

A shopper row is marked by the run id: its device id is `sim-<run id>-d<n>`, and its canon_id is the root identity
stitching derives from a run's device or user id. Journey rows are also limited to `sim_` campaigns, and metric rows to
definitions of `sim_` events. Fixtures go through studio's delete actions: deleting a campaign removes its node rows,
and deleting a catalog event removes its attributes, its metric definitions, and their user_metrics rows.

Clean-up lists what it would remove unless told to apply. A delete cannot be undone, so the engineer reads the list
first. Kafka records stay until the topics' retention removes them: the simulator never writes to a topic.

A load run leaves hundreds of thousands of devices, so clean-up reads the run's identities a batch at a time, in
device id order, and deletes each batch's rows in its own transaction. Memory and transaction size stay bounded, and
a clean-up that fails part way leaves earlier batches deleted: run it again to finish.
"""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass

from cdp_sim.db import Database
from cdp_sim.fixtures import CLEANUP_ACTIONS, DELETE_CAMPAIGN, DELETE_EVENT
from cdp_sim.model import device_root, user_root
from cdp_sim.studio import Studio, StudioError

RUN_ID = re.compile(r"\d{8}t\d{6}-[0-9a-f]{6}")
SIM_NAME = "'sim\\_%'"
# Devices per batch. A batch's roots and transaction stay a few megabytes and tens of thousands of rows.
BATCH = 5000
IDENTITY_PAGE = (
    "SELECT domain_userid, user_id FROM identity_graph WHERE domain_userid LIKE ANY(:patterns)"
    " AND domain_userid > :after ORDER BY domain_userid LIMIT :n"
)
TABLES = ("user_campaign_state_transitions", "user_metrics", "identity_graph")


@dataclass(frozen=True)
class Target:
    table: str
    where: str
    params: dict


def device_patterns(run_ids: list[str]) -> list[str]:
    """LIKE patterns for the run's device ids. A run id must match the simulator's format, so no pattern widens."""
    for run_id in run_ids:
        if not RUN_ID.fullmatch(run_id):
            raise ValueError(f"not a simulator run id: {run_id!r}")
    return [f"sim-{run_id}-%" for run_id in run_ids]


def marked_roots(run_ids: list[str], identities: list[dict]) -> list[str]:
    """The canon_ids derived from the run's own device and user ids. A canon_id stored on a row is not trusted."""
    prefixes = tuple(f"sim-{run_id}-" for run_id in run_ids)
    roots = {device_root(row["domain_userid"]) for row in identities if row["domain_userid"].startswith(prefixes)}
    roots |= {user_root(row["user_id"]) for row in identities if (row["user_id"] or "").startswith(prefixes)}
    return sorted(roots)


def run_device_transitions(patterns: list[str]) -> Target:
    """Transitions of `sim_` campaigns that carry one of the run's device ids, whatever their canon_id."""
    return Target(
        "user_campaign_state_transitions",
        f"campaign_id LIKE {SIM_NAME} AND domain_userid LIKE ANY(:patterns)",
        {"patterns": patterns},
    )


def shopper_targets(run_ids: list[str], patterns: list[str], identities: list[dict]) -> list[Target]:
    """One batch's rows: by the roots derived from its identities, and its identities by device id.

    The transitions already matched by device id are left out, so a dry run counts each row once. Each condition
    leads with a primary key column, so a batch reads by index.
    """
    roots = marked_roots(run_ids, identities)
    return [
        Target(
            "user_campaign_state_transitions",
            f"campaign_id LIKE {SIM_NAME} AND canon_id = ANY(:roots)"
            " AND NOT COALESCE(domain_userid LIKE ANY(:patterns), false)",
            {"roots": roots, "patterns": patterns},
        ),
        Target(
            "user_metrics",
            f"canon_id = ANY(:roots) AND metric_id IN (SELECT id FROM user_metric_definitions WHERE event_name LIKE {SIM_NAME})",
            {"roots": roots},
        ),
        Target("identity_graph", "domain_userid = ANY(:devices)",
               {"devices": [row["domain_userid"] for row in identities]}),
    ]


def identity_batches(db: Database, patterns: list[str]) -> Iterator[list[dict]]:
    """The run's identities, BATCH at a time in device id order. Each page starts after the last one's final id, so
    deleting a page's rows does not shift the next."""
    after = ""
    while page := db.rows(IDENTITY_PAGE, patterns=patterns, after=after, n=BATCH):
        yield page
        after = page[-1]["domain_userid"]


@contextmanager
def transaction(db: Database) -> Iterator[None]:
    db.execute("BEGIN")
    try:
        yield
    except BaseException:
        db.execute("ROLLBACK")
        raise
    db.execute("COMMIT")


def count(db: Database, run_ids: list[str], patterns: list[str]) -> dict[str, int]:
    def rows(target: Target) -> int:
        return db.rows(f"SELECT count(*) AS n FROM {target.table} WHERE {target.where}", **target.params)[0]["n"]

    counts = Counter(dict.fromkeys(TABLES, 0))
    counts["user_campaign_state_transitions"] += rows(run_device_transitions(patterns))
    for page in identity_batches(db, patterns):
        for target in shopper_targets(run_ids, patterns, page):
            counts[target.table] += rows(target)
    return dict(counts)


def delete(db: Database, run_ids: list[str], patterns: list[str]) -> dict[str, int]:
    deleted = Counter(dict.fromkeys(TABLES, 0))
    by_device = run_device_transitions(patterns)
    while True:
        with transaction(db):
            n = db.execute(
                f"DELETE FROM {by_device.table} WHERE ctid = ANY(ARRAY("
                f"SELECT ctid FROM {by_device.table} WHERE {by_device.where} LIMIT :n))",
                n=BATCH, **by_device.params,
            )
        deleted[by_device.table] += n
        if n < BATCH:
            break
    for page in identity_batches(db, patterns):
        with transaction(db):
            for target in shopper_targets(run_ids, patterns, page):
                deleted[target.table] += db.execute(f"DELETE FROM {target.table} WHERE {target.where}", **target.params)
    return dict(deleted)


def fixture_rows(db: Database) -> tuple[list[str], list[dict]]:
    """The `sim_` campaign ids and the `sim_` catalog events' ids and names."""
    campaigns = [row["id"] for row in db.rows(f"SELECT id FROM campaigns WHERE id LIKE {SIM_NAME} ORDER BY id")]
    events = db.rows(f"SELECT id, event_name FROM user_events WHERE event_name LIKE {SIM_NAME} ORDER BY event_name")
    return campaigns, events


def run(run_ids: list[str], include_fixtures: bool, apply: bool, open_studio=None) -> dict:
    """Lists, and with `apply` removes, the run's rows and optionally every `sim_` fixture. Returns what it found."""
    patterns = device_patterns(run_ids)
    reader = Database.connect()
    try:
        counts = count(reader, run_ids, patterns) if not apply else None
        campaigns, events = fixture_rows(reader)
    finally:
        reader.close()
    found: dict = {"run_ids": run_ids, "applied": apply}
    if include_fixtures:
        found["campaigns"] = campaigns
        found["catalog_events"] = [row["event_name"] for row in events]
    if not apply:
        found["rows"] = counts
        return found
    writer = Database.connect(writable=True)
    try:
        found["deleted"] = delete(writer, run_ids, patterns)
    finally:
        writer.close()
    if include_fixtures:
        studio: Studio = open_studio(CLEANUP_ACTIONS)
        errors = []
        deletes = [(DELETE_CAMPAIGN, campaign) for campaign in campaigns] + [(DELETE_EVENT, event["id"]) for event in events]
        for action, fixture_id in deletes:
            try:
                studio.call(action, fixture_id)
            except StudioError as error:
                errors.append(str(error))
        # Studio's answer is not proof: read back what is still there.
        reader = Database.connect()
        try:
            remaining_campaigns, remaining_events = fixture_rows(reader)
        finally:
            reader.close()
        found["not_deleted"] = {
            "campaigns": remaining_campaigns,
            "catalog_events": [row["event_name"] for row in remaining_events],
            "errors": errors,
        }
    return found


def incomplete(found: dict) -> bool:
    """Whether clean-up left a fixture it was asked to delete."""
    left = found.get("not_deleted", {})
    return bool(left.get("campaigns") or left.get("catalog_events"))
