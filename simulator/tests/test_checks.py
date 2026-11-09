import json
import time

from cdp_sim.fixtures import NOTIFY_NODE, SETUP_NODE, WATCH_NODE
from cdp_sim.journey import notification_owner
from cdp_sim.logical import abandoned_cart, duplicate_event, gated_event, identity_stitching, invalid_event, purchase_cancels
from cdp_sim.model import PERSONA_BY_NAME, Shopper, Step, derived_root, device_root, named, script
from cdp_sim.report import ExpectationResult, Report, StageResult
from cdp_sim.smoke import Stage, run_stages
from cdp_sim.topics import Record, TopicTail


class FakeTail(TopicTail):
    def __init__(self, values: list[dict]) -> None:
        self.topic = "t"
        self.records = [Record("t", 0, offset, None, json.dumps(value).encode()) for offset, value in enumerate(values)]

    def poll(self, timeout_ms: int = 500) -> None:
        time.sleep(0.01)


def soon() -> float:
    return time.monotonic() + 0.05


def test_stages_after_a_failure_are_not_reached_and_a_journey_stage_gets_the_window_on_top():
    deadlines = []
    stages = [
        Stage("a", lambda deadline: ("pass", {"seen": 1})),
        Stage("b", lambda deadline: (deadlines.append(deadline - time.monotonic()) or "pass", {}), extra_s=60),
        Stage("c", lambda deadline: ("fail", {})),
        Stage("d", lambda deadline: ("pass", {})),
    ]
    results = run_stages(stages, timeout_s=1)
    assert [(result.stage, result.result) for result in results] == [("a", "pass"), ("b", "pass"), ("c", "fail"), ("d", "not reached")]
    assert results[3].reason == "c failed"
    assert 60 < deadlines[0] <= 61


def test_the_verdict_is_fail_over_incomplete_over_pass():
    report = Report("r1", "smoke", {}, "t0", stages=[StageResult("a", "pass")])
    assert report.verdict == "pass"
    report.stages.append(StageResult("b", "not reached"))
    assert report.verdict == "incomplete"
    report.expectations.append(ExpectationResult("s", "e", ("X-1",), "fail"))
    assert report.verdict == "fail"
    assert json.loads(report.to_json())["verdict"] == "fail"


def test_a_derived_root_matches_javas_name_based_uuid():
    # java.util.UUID.nameUUIDFromBytes("test".getBytes(UTF_8))
    assert derived_root("te", "st") == "098f6bcd-4621-3373-8ade-4e832627b4f6"


def stitching_records(shopper: Shopper, events, canon_ids: list[str]) -> list[dict]:
    return [{"event_id": event.event_id, "canon_id": canon} for event, canon in zip(events, canon_ids)]


def test_identity_stitching_passes_when_the_login_moves_the_shopper_to_the_users_root():
    shopper = Shopper("r1", 3, PERSONA_BY_NAME["buyer"])
    events = script(shopper, (Step.VIEW_PAGE, Step.LOGIN, Step.ADD_TO_CART))
    device, user = derived_root("canon-domain_userid:", shopper.device_id), derived_root("canon:", shopper.user_id)

    good = identity_stitching(FakeTail(stitching_records(shopper, events, [device, user, user])), shopper, events, soon())
    assert [result.result for result in good] == ["pass", "pass"]

    bad = identity_stitching(FakeTail(stitching_records(shopper, events, [device, device, user])), shopper, events, soon())
    assert [result.result for result in bad] == ["pass", "fail"]
    assert bad[1].evidence["actual"][events[1].event_id] == device


def test_invalid_event_fails_when_the_event_without_an_id_reaches_snowplow_parsed():
    shopper = Shopper("r1", 1, PERSONA_BY_NAME["browser"])
    [sentinel] = script(shopper, (Step.VIEW_PAGE,))
    dead = FakeTail([{"record": "event", "reason": "invalid_event_id", "detail": "eid", "event": {"duid": shopper.device_id}}])
    clean = FakeTail([{"event_id": sentinel.event_id, "domain_userid": shopper.device_id}])
    leaked = FakeTail([{"event_id": sentinel.event_id, "domain_userid": shopper.device_id},
                       {"event_id": None, "domain_userid": shopper.device_id}])

    assert [result.result for result in invalid_event(clean, dead, shopper, sentinel, soon())] == ["pass", "pass"]
    assert [result.result for result in invalid_event(leaked, FakeTail([]), shopper, sentinel, soon())] == ["fail", "fail"]


CAMPAIGN = "sim_abandoned_cart_60s"


def request(shopper: Shopper, execution_id: str, device: str | None = "same", campaign: str = CAMPAIGN) -> dict:
    return {
        "metadata": {"campaign_id": campaign, "node_id": NOTIFY_NODE, "execution_id": execution_id},
        "channel": "webhook",
        "profile": {"domain_user_id": shopper.device_id if device == "same" else device},
    }


def row(shopper: Shopper, node_id: str, branch: str, event_id: str | None = None) -> dict:
    return {"canon_id": device_root(shopper.device_id), "domain_userid": shopper.device_id, "entry_id": "first",
            "node_id": node_id, "branch": branch, "node_type": "x", "event_id": event_id}


def test_a_request_is_matched_to_its_shopper_by_device_or_by_canon_id_in_its_execution_id():
    a, b = Shopper("r1", 5, PERSONA_BY_NAME["hesitant"]), Shopper("r1", 6, PERSONA_BY_NAME["hesitant"])
    owner = notification_owner(CAMPAIGN, [a, b])
    tail = FakeTail([
        request(a, "x"),
        request(b, f"{CAMPAIGN}_{NOTIFY_NODE}_{device_root(b.device_id)}_first", device=None),
        request(a, "y", campaign="CAMP-OTHER"),
    ])
    assert {key: len(records) for key, records in tail.all(owner).items()} == {a.device_id: 1, b.device_id: 1}


def test_abandoned_cart_wants_exactly_one_request_with_a_derived_execution_id():
    shopper = Shopper("r1", 5, PERSONA_BY_NAME["hesitant"])
    good_id = f"{CAMPAIGN}_{NOTIFY_NODE}_{device_root(shopper.device_id)}_first"
    rows = [row(shopper, SETUP_NODE, "next")]
    one = FakeTail([request(shopper, good_id)]).records
    assert [r.result for r in abandoned_cart(CAMPAIGN, shopper, rows, one)] == ["pass", "pass"]

    two = FakeTail([request(shopper, good_id), request(shopper, good_id)]).records
    assert [r.result for r in abandoned_cart(CAMPAIGN, shopper, rows, two)] == ["fail", "pass"]
    random_ids = FakeTail([request(shopper, "a1"), request(shopper, "b2")]).records
    assert [r.result for r in abandoned_cart(CAMPAIGN, shopper, rows, random_ids)] == ["fail", "fail"]
    none = abandoned_cart(CAMPAIGN, shopper, [], [])
    assert [r.result for r in none] == ["fail", "fail"] and none[0].reason == "the shopper never entered the journey"


def test_purchase_cancels_needs_the_watch_to_succeed_and_no_request():
    shopper = Shopper("r1", 6, PERSONA_BY_NAME["buyer"])
    rows = [row(shopper, SETUP_NODE, "next"), row(shopper, WATCH_NODE, "success")]
    assert purchase_cancels(shopper, rows, []).result == "pass"
    assert purchase_cancels(shopper, rows, FakeTail([request(shopper, "x")]).records).result == "fail"
    assert purchase_cancels(shopper, rows[:1], []).result == "fail"


def test_a_duplicate_event_id_gives_one_transition_and_at_most_one_request():
    shopper = Shopper("r1", 7, PERSONA_BY_NAME["hesitant"])
    [event] = script(shopper, (Step.ADD_TO_CART,))
    once = [row(shopper, SETUP_NODE, "next", event.event_id)]
    assert [r.result for r in duplicate_event(shopper, event, once, FakeTail([request(shopper, "x")]).records)] == ["pass", "pass"]
    twice_requested = FakeTail([request(shopper, "x"), request(shopper, "x")]).records
    assert [r.result for r in duplicate_event(shopper, event, once, twice_requested)] == ["pass", "fail"]
    other_entry = once + [{**once[0], "entry_id": "e2"}]
    assert duplicate_event(shopper, event, other_entry, [])[0].result == "fail"


def test_a_gated_event_must_be_dead_lettered_while_its_valid_twin_is_parsed():
    shopper = Shopper("r1", 4, PERSONA_BY_NAME["browser"])
    valid, broken = named(shopper, "sim_gated_check", {"sku": "S"}), named(shopper, "sim_gated_check", {})
    letter = {"record": "event", "reason": "schema_invalid", "detail": "sku missing (string)", "event": {"event_id": broken.event_id}}
    parsed = FakeTail([{"event_id": valid.event_id}])
    assert gated_event(parsed, FakeTail([letter]), valid, broken, soon()).result == "pass"
    leaked = FakeTail([{"event_id": valid.event_id}, {"event_id": broken.event_id}])
    assert gated_event(leaked, FakeTail([letter]), valid, broken, soon()).result == "fail"
    assert gated_event(parsed, FakeTail([]), valid, broken, soon()).result == "fail"
