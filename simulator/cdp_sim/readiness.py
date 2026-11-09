"""Waits until the engine applies the fixtures a prepare just changed, before the run's own shoppers send anything.

Publishing writes rows; the engine learns of them through CDC. Customer decision drops a trigger for a rule it does not
hold yet, and journey execution may take up to its graph-load allowance (JEX-NFR-09, 5 minutes) to apply a new graph.
The signal that both have the campaign is a transition row in user_campaign_state_transitions for a probe shopper who
added to the cart: only a state machine holding the graph writes it. A new probe is sent every interval, because an
early probe may have been dropped by a customer decision that did not hold the rule yet. A probe that entered then
purchases, so it leaves no notification request.

The schema gate also reaches ingestion through CDC. The signal that it applies is a probe event that breaks the gated
schema reaching the dead-letter topic with reason `schema_invalid`.

Probe shoppers have indexes from 900 and the run's ids, so clean-up removes them with the run.
"""

from __future__ import annotations

import time

from cdp_sim import journey
from cdp_sim.db import Database
from cdp_sim.fixtures import GATED_EVENT, SETUP_NODE, FixtureError, Fixtures
from cdp_sim.model import PERSONA_BY_NAME, Shopper, Step, named, script
from cdp_sim.topics import Record, TopicTail
from cdp_sim.tracker import Collector

GRAPH_TIMEOUT_S = 330.0
GRAPH_PROBE_EVERY_S = 15.0
GATE_TIMEOUT_S = 120.0
GATE_PROBE_EVERY_S = 5.0
GRAPH_PROBE_INDEX, GATE_PROBE_INDEX = 900, 950


def await_graph(collector: Collector, db: Database, fixtures: Fixtures, run_id: str) -> dict:
    started = time.monotonic()
    deadline = started + GRAPH_TIMEOUT_S
    probes: list[Shopper] = []
    next_probe = started
    while time.monotonic() < deadline:
        if time.monotonic() >= next_probe:
            probe = Shopper(run_id, GRAPH_PROBE_INDEX + len(probes), PERSONA_BY_NAME["hesitant"])
            collector.post(script(probe, (Step.ADD_TO_CART,)))
            probes.append(probe)
            next_probe = time.monotonic() + GRAPH_PROBE_EVERY_S
        rows = journey.transitions(db, fixtures.campaign_id, probes)
        entered = next((probe for probe in probes if journey.of(rows, probe, SETUP_NODE)), None)
        if entered:
            collector.post(script(entered, (Step.PURCHASE,)))
            return {"probe": entered.device_id, "probes_sent": len(probes), "seconds": round(time.monotonic() - started, 1)}
        time.sleep(journey.POLL_S)
    raise FixtureError(
        f"campaign {fixtures.campaign_id}: no probe shopper entered the journey within {GRAPH_TIMEOUT_S:.0f} s of "
        f"publishing, so the engine does not hold its graph (probes {probes[0].device_id} onward)"
    )


def await_gate(collector: Collector, brokers: str, run_id: str) -> dict:
    tail = TopicTail(brokers, "snowplow-parsed-dead-letters", f"sim-{run_id}-gate-probe")
    started = time.monotonic()
    probes: list[str] = []
    try:
        while time.monotonic() < started + GATE_TIMEOUT_S:
            probe = Shopper(run_id, GATE_PROBE_INDEX + len(probes), PERSONA_BY_NAME["browser"])
            event = named(probe, GATED_EVENT, {})
            collector.post([event])
            probes.append(event.event_id)
            found = tail.collect(gate_drop, set(probes), time.monotonic() + GATE_PROBE_EVERY_S)
            if found:
                return {"probes_sent": len(probes), "seconds": round(time.monotonic() - started, 1)}
    finally:
        tail.close()
    raise FixtureError(f"catalog event {GATED_EVENT}: ingestion did not apply its schema gate within {GATE_TIMEOUT_S:.0f} s")


def gate_drop(record: Record) -> str | None:
    """The event id of a `schema_invalid` dead letter. Its `event` is the parsed event, so the id is `event_id`."""
    value = record.json() or {}
    event = value.get("event") if isinstance(value.get("event"), dict) else {}
    return event.get("event_id") if value.get("record") == "event" and value.get("reason") == "schema_invalid" else None
