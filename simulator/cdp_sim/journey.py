"""What journey execution and the outbox produced for a run's shoppers in a `sim_` campaign.

Transitions are read from Postgres, in a read-only session, scoped to one `sim_` campaign and the run's shoppers.
Notification requests are read from `journey-engine-outbound-noti` and matched to a shopper by its device id, or by its
canon_id inside the request's execution_id when the profile carries no device id.
"""

from __future__ import annotations

import time
from collections.abc import Callable, Iterable

from cdp_sim.db import Database
from cdp_sim.model import Shopper, device_root
from cdp_sim.topics import Record

TRANSITIONS = "user_campaign_state_transitions"
POLL_S = 1.0


def transitions(db: Database, campaign_id: str, shoppers: Iterable[Shopper]) -> list[dict]:
    shoppers = list(shoppers)
    return db.rows(
        "SELECT canon_id, domain_userid, entry_id, node_id, branch, node_type, event_id::text AS event_id"
        f" FROM {TRANSITIONS}"
        " WHERE campaign_id = :campaign AND (domain_userid = ANY(:devices) OR canon_id = ANY(:canons))"
        " ORDER BY transitioned_at",
        campaign=campaign_id,
        devices=[shopper.device_id for shopper in shoppers],
        canons=[device_root(shopper.device_id) for shopper in shoppers],
    )


def wait_for(
    db: Database, campaign_id: str, shoppers: Iterable[Shopper], done: Callable[[list[dict]], bool], deadline: float
) -> list[dict]:
    """Polls the shoppers' transitions until `done` holds or the monotonic deadline passes. Returns the last read."""
    shoppers = list(shoppers)
    while True:
        rows = transitions(db, campaign_id, shoppers)
        if done(rows) or time.monotonic() >= deadline:
            return rows
        time.sleep(POLL_S)


def of(rows: list[dict], shopper: Shopper, node_id: str | None = None) -> list[dict]:
    canon = device_root(shopper.device_id)
    return [
        row for row in rows
        if (row["domain_userid"] == shopper.device_id or row["canon_id"] == canon)
        and (node_id is None or row["node_id"] == node_id)
    ]


def notification_owner(campaign_id: str, shoppers: Iterable[Shopper]) -> Callable[[Record], str | None]:
    """A key function for the outbound topic: the device id of the shopper a request in this campaign is for."""
    by_device = {shopper.device_id: shopper.device_id for shopper in shoppers}
    by_canon = {device_root(device): device for device in by_device}

    def owner(record: Record) -> str | None:
        value = record.json() or {}
        metadata = value.get("metadata") if isinstance(value.get("metadata"), dict) else {}
        if metadata.get("campaign_id") != campaign_id:
            return None
        profile = value.get("profile") if isinstance(value.get("profile"), dict) else {}
        if profile.get("domain_user_id") in by_device:
            return profile["domain_user_id"]
        execution_id = str(metadata.get("execution_id") or "")
        return next((device for canon, device in by_canon.items() if f"_{canon}_" in execution_id), None)

    return owner


def describe_request(record: Record) -> dict:
    value = record.json() or {}
    metadata = value.get("metadata") if isinstance(value.get("metadata"), dict) else {}
    return {**record.where(), "node_id": metadata.get("node_id"), "execution_id": metadata.get("execution_id"),
            "channel": value.get("channel")}
