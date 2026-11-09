"""Smoke: one shopper's events, followed through every stage in order (SIM-FR-07).

The shopper views a product and adds it to the cart. The add to cart enters the `sim_` abandoned-cart journey, whose
setup condition keeps the metric definition on `sim_add_to_cart` LIVE, so the same event reaches
`customer-profile-mutations`, `journey-engine-matched-events`, and `user_campaign_state_transitions`. The shopper never
buys, so the watch times out and the outbox publishes one request: the last stage waits up to the window longer.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass

from cdp_sim import journey
from cdp_sim.db import Database
from cdp_sim.fixtures import SETUP_NODE, Fixtures
from cdp_sim.model import PERSONA_BY_NAME, Shopper, Step, device_root, script
from cdp_sim.report import StageOutcome, StageResult
from cdp_sim.settings import Settings
from cdp_sim.topics import Record, TopicTail
from cdp_sim.tracker import Collector

GOOD, PARSED, DEAD_LETTERS = "snowplow-good", "snowplow-parsed", "snowplow-parsed-dead-letters"
MUTATIONS, MATCHED, OUTBOUND = "customer-profile-mutations", "journey-engine-matched-events", "journey-engine-outbound-noti"
SMOKE_STEPS = (Step.VIEW_PRODUCT, Step.ADD_TO_CART)
# How long the dead-letter check reads after the events reached snowplow-parsed. Ingestion writes both from one pass.
DEAD_LETTER_GRACE_S = 5.0

Check = Callable[[float], tuple[StageOutcome, dict]]


@dataclass(frozen=True)
class Stage:
    name: str
    check: Check
    # Added to the stage timeout for a stage that waits on a journey's window.
    extra_s: float = 0.0


def run_stages(stages: list[Stage], timeout_s: float) -> list[StageResult]:
    """Checks each stage in order. After a stage that is not a pass, every later stage is `not reached`."""
    results: list[StageResult] = []
    blocked: str | None = None
    for stage in stages:
        if blocked is not None:
            results.append(StageResult(stage.name, "not reached", reason=blocked))
            continue
        started = time.monotonic()
        outcome, evidence = stage.check(started + timeout_s + stage.extra_s)
        results.append(StageResult(stage.name, outcome, evidence, seconds=round(time.monotonic() - started, 2)))
        if outcome != "pass":
            blocked = f"{stage.name} failed"
    return results


def not_reached(stages: list[str], reason: str) -> list[StageResult]:
    return [StageResult(stage, "not reached", reason=reason) for stage in stages]


STAGES = ("collector", GOOD, PARSED, DEAD_LETTERS, MUTATIONS, MATCHED, journey.TRANSITIONS, OUTBOUND)


def found_evidence(found: dict, wanted: set, describe: Callable[[Record], dict], timeout_s: float) -> dict:
    evidence: dict = {"found": {key: describe(record) for key, record in found.items()}}
    if missing_keys := sorted(wanted - found.keys()):
        evidence["missing"] = missing_keys
        evidence["timeout_s"] = timeout_s
    return evidence


def run(settings: Settings, fixtures: Fixtures, db: Database, run_id: str) -> list[StageResult]:
    shopper = Shopper(run_id, 0, PERSONA_BY_NAME["hesitant"])
    events = script(shopper, SMOKE_STEPS)
    event_ids = {event.event_id for event in events}
    cart_id = events[-1].event_id
    topics = (GOOD, PARSED, DEAD_LETTERS, MUTATIONS, MATCHED, OUTBOUND)
    tails = {topic: TopicTail(settings.kafka_brokers, topic, f"sim-{run_id}-{topic}") for topic in topics}
    collector = Collector(settings.collector_url)
    hits = [collector.post(events[:-1]), collector.pixel(events[-1])]
    timeout_s = settings.stage_timeout_s
    campaign = fixtures.campaign_id

    def collector_check(_deadline: float) -> tuple[StageOutcome, dict]:
        evidence = {"hits": [{"method": hit.method, "status": hit.status, "error": hit.error, "event_ids": hit.event_ids} for hit in hits]}
        return ("pass" if all(hit.ok for hit in hits) else "fail"), evidence

    def good_check(deadline: float) -> tuple[StageOutcome, dict]:
        def key_of(record: Record) -> str | None:
            return next((event_id for event_id in event_ids if record.value and event_id.encode() in record.value), None)

        found = tails[GOOD].collect(key_of, event_ids, deadline)
        evidence = found_evidence(found, event_ids, Record.where, timeout_s)
        return ("pass" if found.keys() == event_ids else "fail"), evidence

    def parsed_check(deadline: float) -> tuple[StageOutcome, dict]:
        def describe(record: Record) -> dict:
            value = record.json() or {}
            return {**record.where(), "event_name": value.get("event_name"), "canon_id": value.get("canon_id")}

        found = tails[PARSED].collect(lambda record: (record.json() or {}).get("event_id"), event_ids, deadline)
        evidence = found_evidence(found, event_ids, describe, timeout_s)
        return ("pass" if found.keys() == event_ids else "fail"), evidence

    def dead_letter_check(_deadline: float) -> tuple[StageOutcome, dict]:
        tail = tails[DEAD_LETTERS]
        tail.collect(lambda record: None, {object()}, time.monotonic() + DEAD_LETTER_GRACE_S)
        mine = [record.where() for record in tail.records if dead_letter_device(record) == shopper.device_id]
        return ("fail" if mine else "pass"), {"dead_letters_for_shopper": mine, "read_for_s": DEAD_LETTER_GRACE_S}

    def mutation_check(deadline: float) -> tuple[StageOutcome, dict]:
        def describe(record: Record) -> dict:
            value = record.json() or {}
            metrics = value.get("metrics")
            return {**record.where(), "canonId": value.get("canonId"),
                    "metrics": sorted(metrics) if isinstance(metrics, dict) else metrics}

        found = tails[MUTATIONS].collect(lambda record: (record.json() or {}).get("eventId"), {cart_id}, deadline)
        evidence = found_evidence(found, {cart_id}, describe, timeout_s)
        evidence["metric_definition"] = fixtures.metric_definition_id
        return ("pass" if found else "fail"), evidence

    def matched_check(deadline: float) -> tuple[StageOutcome, dict]:
        def key_of(record: Record) -> str | None:
            value = record.json() or {}
            return value.get("event_id") if value.get("campaign_id") == campaign else None

        def describe(record: Record) -> dict:
            value = record.json() or {}
            return {**record.where(), "node_id": value.get("node_id"), "branch": value.get("branch")}

        found = tails[MATCHED].collect(key_of, {cart_id}, deadline)
        return ("pass" if found else "fail"), found_evidence(found, {cart_id}, describe, timeout_s)

    def transition_check(deadline: float) -> tuple[StageOutcome, dict]:
        rows = journey.wait_for(db, campaign, [shopper], lambda rows: bool(journey.of(rows, shopper, SETUP_NODE)), deadline)
        entered = journey.of(rows, shopper, SETUP_NODE)
        return ("pass" if entered else "fail"), {"campaign_id": campaign, "rows": rows, "timeout_s": timeout_s}

    def outbound_check(deadline: float) -> tuple[StageOutcome, dict]:
        owner = journey.notification_owner(campaign, [shopper])
        found = tails[OUTBOUND].collect(owner, {shopper.device_id}, deadline)
        evidence = found_evidence(found, {shopper.device_id}, journey.describe_request, timeout_s + fixtures.window_s)
        evidence["canon_id"] = device_root(shopper.device_id)
        return ("pass" if found else "fail"), evidence

    stages = [
        Stage("collector", collector_check),
        Stage(GOOD, good_check),
        Stage(PARSED, parsed_check),
        Stage(DEAD_LETTERS, dead_letter_check),
        Stage(MUTATIONS, mutation_check),
        Stage(MATCHED, matched_check),
        Stage(journey.TRANSITIONS, transition_check),
        Stage(OUTBOUND, outbound_check, extra_s=fixtures.window_s),
    ]
    try:
        return run_stages(stages, timeout_s)
    finally:
        for tail in tails.values():
            tail.close()


def dead_letter_device(record: Record) -> str | None:
    """The device id of a dead letter's event: `duid` on a tracker event, `domain_userid` on a parsed one."""
    event = (record.json() or {}).get("event")
    if not isinstance(event, dict):
        return None
    return event.get("duid") or event.get("domain_userid")
