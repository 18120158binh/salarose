"""Logical: scripted shoppers whose outcome is known in advance, checked against topics and tables (SIM-FR-08).

Every scenario's shoppers send at once. The ingestion scenarios are checked within the stage timeout. The journey
scenarios share the `sim_` abandoned-cart campaign and are checked after its window and the stage timeout have passed,
so that a late or second notification request is seen.
"""

from __future__ import annotations

import json
import time
import uuid
from dataclasses import replace

from cdp_sim import journey
from cdp_sim.db import Database
from cdp_sim.fixtures import GATED_ATTRIBUTE, NOTIFY_NODE, SETUP_NODE, WATCH_NODE, Fixtures
from cdp_sim.model import (
    PERSONA_BY_NAME, Shopper, Step, TrackedEvent, device_root, named, now_ms, script, user_root,
)
from cdp_sim.readiness import gate_drop
from cdp_sim.report import ExpectationResult
from cdp_sim.settings import Settings
from cdp_sim.smoke import DEAD_LETTERS, OUTBOUND, PARSED, dead_letter_device
from cdp_sim.topics import Record, TopicTail
from cdp_sim.tracker import Collector, HitResult

STRUCT_ACTION = "SIM_Struct_Check"


def structured(shopper: Shopper, fields: dict[str, str]) -> TrackedEvent:
    return TrackedEvent(
        run_id=shopper.run_id,
        device_id=shopper.device_id,
        user_id=None,
        event_id=str(uuid.uuid4()),
        timestamp_ms=now_ms(),
        name=None,
        attributes=fields,
        structured=True,
    )


def parsed_by_id(record: Record) -> str | None:
    return (record.json() or {}).get("event_id")


def run(settings: Settings, fixtures: Fixtures, db: Database, run_id: str) -> list[ExpectationResult]:
    invalid_shopper = Shopper(run_id, 1, PERSONA_BY_NAME["browser"])
    sentinel, no_id = script(invalid_shopper, (Step.VIEW_PAGE, Step.VIEW_PRODUCT))
    no_id = replace(no_id, event_id=None)

    struct_shopper = Shopper(run_id, 2, PERSONA_BY_NAME["browser"])
    struct_event = structured(struct_shopper, {"se_ca": "sim", "se_ac": STRUCT_ACTION, "se_la": run_id, "se_va": "12.5"})
    struct_no_action = structured(struct_shopper, {"se_ca": "sim", "se_la": run_id})

    stitch_shopper = Shopper(run_id, 3, PERSONA_BY_NAME["buyer"])
    stitch_events = script(stitch_shopper, (Step.VIEW_PAGE, Step.VIEW_PRODUCT, Step.LOGIN, Step.ADD_TO_CART))

    gated_shopper = Shopper(run_id, 4, PERSONA_BY_NAME["browser"])
    gated_valid = named(gated_shopper, fixtures.gated_event, {GATED_ATTRIBUTE: "SIM-SKU-001"})
    gated_broken = named(gated_shopper, fixtures.gated_event, {})

    cart = Shopper(run_id, 5, PERSONA_BY_NAME["hesitant"])
    buyer = Shopper(run_id, 6, PERSONA_BY_NAME["buyer"])
    twice = Shopper(run_id, 7, PERSONA_BY_NAME["hesitant"])
    journey_shoppers = (cart, buyer, twice)
    [repeated] = script(twice, (Step.ADD_TO_CART,))

    topics = (PARSED, DEAD_LETTERS, OUTBOUND)
    tails = {topic: TopicTail(settings.kafka_brokers, topic, f"sim-{run_id}-{topic}") for topic in topics}
    collector = Collector(settings.collector_url)
    hits = [
        collector.post([sentinel, no_id]),
        collector.post([struct_event, struct_no_action]),
        # One payload, so ingestion reads the login after the anonymous events. Two hits can land on two partitions.
        collector.post(stitch_events),
        collector.post([gated_valid, gated_broken]),
        collector.post(script(cart, (Step.ADD_TO_CART,))),
        collector.post(script(buyer, (Step.ADD_TO_CART,))),
        collector.post([repeated]),
        collector.post([repeated]),
    ]
    deadline = time.monotonic() + settings.stage_timeout_s
    parsed, dead, outbound = tails[PARSED], tails[DEAD_LETTERS], tails[OUTBOUND]
    campaign = fixtures.campaign_id
    try:
        if failed := [hit for hit in hits if not hit.ok]:
            return [collector_failure(failed)]
        results = [
            *invalid_event(parsed, dead, invalid_shopper, sentinel, deadline),
            gated_event(parsed, dead, gated_valid, gated_broken, deadline),
            *structured_event(parsed, dead, struct_event, struct_no_action, run_id, deadline),
            *identity_stitching(parsed, stitch_shopper, stitch_events, deadline),
        ]
        # The purchase waits for the buyer's own entry, and only for it: a success trigger that reaches a shopper not
        # yet waiting changes nothing, and a slow sibling must not use up the buyer's window.
        buyer_entered = journey.wait_for(db, campaign, (buyer,), lambda rows: bool(journey.of(rows, buyer, SETUP_NODE)), deadline)
        if journey.of(buyer_entered, buyer, SETUP_NODE):
            collector.post(script(buyer, (Step.PURCHASE,)))
        journey.wait_for(
            db, campaign, journey_shoppers,
            lambda rows: all(journey.of(rows, shopper, SETUP_NODE) for shopper in journey_shoppers), deadline,
        )
        # Every watch started before now, so its timer fires within the window from now. The stage timeout covers the
        # outbox's delay, and a second request for the same transition would arrive within it too.
        outbound.read_until(time.monotonic() + fixtures.window_s + settings.stage_timeout_s)
        rows = journey.transitions(db, campaign, journey_shoppers)
        requests = outbound.all(journey.notification_owner(campaign, journey_shoppers))
        return [
            *results,
            *abandoned_cart(campaign, cart, rows, requests.get(cart.device_id, [])),
            purchase_cancels(buyer, rows, requests.get(buyer.device_id, [])),
            *duplicate_event(twice, repeated, rows, requests.get(twice.device_id, [])),
        ]
    finally:
        for tail in tails.values():
            tail.close()


def entry_evidence(rows: list[dict], shopper: Shopper, requests: list[Record]) -> dict:
    return {
        "device_id": shopper.device_id,
        "canon_id": device_root(shopper.device_id),
        "transitions": journey.of(rows, shopper),
        "requests": [journey.describe_request(record) for record in requests],
    }


def abandoned_cart(campaign: str, shopper: Shopper, rows: list[dict], requests: list[Record]) -> list[ExpectationResult]:
    scenario = "Abandoned cart"
    entered = bool(journey.of(rows, shopper, SETUP_NODE))
    one = ExpectationResult(
        scenario, "Exactly one notification request for the shopper and campaign after the window",
        ("OUT-FR-01", "JEX-FR-07", "JEX-FR-08"), "pass" if len(requests) == 1 else "fail",
        entry_evidence(rows, shopper, requests), reason=None if entered else "the shopper never entered the journey",
    )
    canon = device_root(shopper.device_id)
    execution_ids = sorted({str(journey.describe_request(record)["execution_id"]) for record in requests})
    derived = len(execution_ids) == 1 and all(part in execution_ids[0] for part in (campaign, NOTIFY_NODE, canon))
    same = ExpectationResult(
        scenario, "Every request for the transition has one execution_id, derived from its campaign, node, and canon_id",
        ("OUT-FR-05",), "pass" if derived else "fail",
        {"execution_ids": execution_ids, "campaign_id": campaign, "node_id": NOTIFY_NODE, "canon_id": canon},
        reason=None if requests else "no request to compare",
    )
    return [one, same]


def purchase_cancels(shopper: Shopper, rows: list[dict], requests: list[Record]) -> ExpectationResult:
    entered = bool(journey.of(rows, shopper, SETUP_NODE))
    succeeded = any(row["branch"] == "success" for row in journey.of(rows, shopper, WATCH_NODE))
    return ExpectationResult(
        "Purchase cancels", "No notification request for the shopper and campaign after a purchase within the window",
        ("OUT-FR-01", "JEX-FR-01"), "pass" if entered and succeeded and not requests else "fail",
        entry_evidence(rows, shopper, requests),
        reason=None if entered else "the shopper never entered the journey, so the purchase was never sent",
    )


def duplicate_event(
    shopper: Shopper, event: TrackedEvent, rows: list[dict], requests: list[Record]
) -> list[ExpectationResult]:
    scenario = "Duplicate event"
    entries = journey.of(rows, shopper, SETUP_NODE)
    evidence = {**entry_evidence(rows, shopper, requests), "event_id": event.event_id}
    return [
        ExpectationResult(
            scenario, "One transition for an event id sent twice", ("DEC-FR-01", "JEX-FR-10"),
            "pass" if len(entries) == 1 and entries[0]["event_id"] == event.event_id else "fail", evidence,
        ),
        ExpectationResult(
            scenario, "At most one notification request for an event id sent twice", ("OUT-FR-01", "OUT-FR-05"),
            "pass" if len(requests) <= 1 else "fail", evidence,
        ),
    ]


def gated_event(
    parsed: TopicTail, dead: TopicTail, valid: TrackedEvent, broken: TrackedEvent, deadline: float
) -> ExpectationResult:
    """The event that misses the gated event's required attribute is dropped. Its valid twin in the same payload shows
    that ingestion read the payload."""
    dropped = dead.collect(gate_drop, {broken.event_id}, deadline)
    seen = parsed.collect(parsed_by_id, {valid.event_id}, deadline)
    leaked = [record.where() for record in parsed.records if parsed_by_id(record) == broken.event_id]
    letter = dead_letter(dropped[broken.event_id]) if dropped else None
    return ExpectationResult(
        "Invalid event",
        "An event that breaks a gated sim_ schema reaches the dead-letter topic with reason schema_invalid, not snowplow-parsed",
        ("ING-FR-12", "ING-FR-13"), "pass" if letter and seen and not leaked else "fail",
        {"event_id": broken.event_id, "dead_letter": letter, "valid_twin_parsed": bool(seen), "reached_parsed": leaked},
    )


def collector_failure(failed: list[HitResult]) -> ExpectationResult:
    return ExpectationResult(
        "all", "The collector accepts every hit", ("ING-FR-01",), "fail",
        {"hits": [{"method": hit.method, "status": hit.status, "error": hit.error} for hit in failed]},
    )


def dead_letter(record: Record) -> dict:
    value = record.json() or {}
    return {**record.where(), "record": value.get("record"), "reason": value.get("reason"), "detail": value.get("detail")}


def invalid_event(
    parsed: TopicTail, dead: TopicTail, shopper: Shopper, sentinel: TrackedEvent, deadline: float
) -> list[ExpectationResult]:
    scenario = "Invalid event"

    def no_id_drop(record: Record) -> str | None:
        value = record.json() or {}
        mine = value.get("record") == "event" and dead_letter_device(record) == shopper.device_id
        return "dropped" if mine and value.get("reason") == "invalid_event_id" else None

    dropped = dead.collect(no_id_drop, {"dropped"}, deadline)
    reached_dead = ExpectationResult(
        scenario, "An event without an event id reaches the dead-letter topic with reason invalid_event_id",
        ("ING-FR-03", "ING-FR-13"), "pass" if dropped else "fail",
        {"dead_letter": dead_letter(dropped["dropped"])} if dropped else {"missing": "invalid_event_id dead letter"},
    )

    seen = parsed.collect(parsed_by_id, {sentinel.event_id}, deadline)
    others = [
        record.where() for record in parsed.records
        if (record.json() or {}).get("domain_userid") == shopper.device_id and parsed_by_id(record) != sentinel.event_id
    ]
    if not seen:
        absent = ExpectationResult(
            scenario, "An event without an event id does not reach snowplow-parsed", ("ING-FR-03",), "fail",
            {"sentinel": sentinel.event_id}, reason="the valid event sent in the same payload never reached snowplow-parsed",
        )
    else:
        absent = ExpectationResult(
            scenario, "An event without an event id does not reach snowplow-parsed", ("ING-FR-03",),
            "fail" if others else "pass", {"sentinel": seen[sentinel.event_id].where(), "other_events_of_shopper": others},
        )
    return [reached_dead, absent]


def structured_event(
    parsed: TopicTail, dead: TopicTail, event: TrackedEvent, no_action: TrackedEvent, run_id: str, deadline: float
) -> list[ExpectationResult]:
    scenario = "Structured event"
    found = parsed.collect(parsed_by_id, {event.event_id}, deadline)
    value = (found[event.event_id].json() or {}) if found else {}
    try:
        event_json = json.loads(value.get("event_json") or "{}")
    except ValueError:
        event_json = {}
    expected_json = {"category": "sim", "action": STRUCT_ACTION, "label": run_id, "value": 12.5}
    actual_json = {key: event_json.get(key) for key in expected_json}
    named = ExpectationResult(
        scenario, "A structured event's event_name is its lowercased se_ac", ("ING-FR-14",),
        "pass" if value.get("event_name") == STRUCT_ACTION.lower() else "fail",
        {"event_id": event.event_id, "event_name": value.get("event_name"), "found": bool(found)},
    )
    fields = ExpectationResult(
        scenario, "A structured event's event_json holds its se_* fields, with value as a number", ("ING-FR-16",),
        "pass" if actual_json == expected_json else "fail", {"expected": expected_json, "actual": actual_json},
    )

    def no_action_drop(record: Record) -> str | None:
        value = record.json() or {}
        tracker_event = value.get("event") if isinstance(value.get("event"), dict) else {}
        return "dropped" if value.get("record") == "event" and tracker_event.get("eid") == no_action.event_id else None

    dropped = dead.collect(no_action_drop, {"dropped"}, deadline)
    letter = dead_letter(dropped["dropped"]) if dropped else None
    drop = ExpectationResult(
        scenario, "A structured event without se_ac reaches the dead-letter topic with reason event_not_decoded",
        ("ING-FR-14", "ING-FR-13"),
        "pass" if letter and letter["reason"] == "event_not_decoded" and letter["detail"] == "se_ac" else "fail",
        {"event_id": no_action.event_id, "dead_letter": letter},
    )
    return [named, fields, drop]


def identity_stitching(
    parsed: TopicTail, shopper: Shopper, events: list[TrackedEvent], deadline: float
) -> list[ExpectationResult]:
    """Before login a device's events carry its own derived root. From login on they carry the user's root.

    The identity stitching contract's worked example (IDS-FR-01, IDS-FR-02, IDS-FR-04) says so. Events published
    before the login keep their earlier canon_id.
    """
    scenario = "Identity stitching"
    found = parsed.collect(parsed_by_id, {event.event_id for event in events}, deadline)
    device, user = device_root(shopper.device_id), user_root(shopper.user_id)

    def check(subset: list[TrackedEvent], root: str) -> tuple[str, dict]:
        actual = {event.event_id: (found[event.event_id].json() or {}).get("canon_id") if event.event_id in found else None for event in subset}
        return ("pass" if all(canon == root for canon in actual.values()) else "fail"), {"expected": root, "actual": actual}

    login = next(index for index, event in enumerate(events) if event.user_id is not None)
    before, before_evidence = check(events[:login], device)
    after, after_evidence = check(events[login:], user)
    return [
        ExpectationResult(
            scenario, "Anonymous events carry the device's derived canon_id", ("ING-FR-07", "IDS-FR-01", "IDS-FR-04"),
            before, before_evidence,
        ),
        ExpectationResult(
            scenario, "The login event and every later event carry the user's canon_id",
            ("ING-FR-07", "IDS-FR-02", "IDS-FR-04"), after, after_evidence,
        ),
    ]
