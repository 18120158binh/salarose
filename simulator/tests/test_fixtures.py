import re
from urllib.parse import urlparse
from pathlib import Path

import pytest

from cdp_sim.fixtures import (
    ADD_ATTRIBUTE, CATALOG, CREATE_EVENT, GATED_EVENT, PUBLISH, SET_GATE, SET_REQUIRED, FixtureError, Stored, StoredEvent,
    abandoned_cart, campaign_id, plan, prepare,
)
from cdp_sim.model import FUNNEL
from cdp_sim.studio import StudioError


class Catalog:
    """Studio and Postgres in one: the actions write rows, and the fixtures' reads see them."""

    def __init__(self) -> None:
        self.events: dict[str, dict] = {}
        self.campaigns: dict[str, dict] = {}
        self.calls: list[str] = []
        self.sign_ins = 0

    def open_studio(self, actions):
        self.sign_ins += 1
        return self

    def call(self, action, *args):
        self.calls.append(action)
        by_id = {event["id"]: event for event in self.events.values()}
        if action == CREATE_EVENT:
            name, _, _, _, fields = args
            self.events[name] = {"id": f"ue_{len(self.events)}", "gated": False,
                                 "fields": {f["fieldPath"]: [f["dataType"], False] for f in fields}}
            return {"success": True, "eventId": self.events[name]["id"]}
        if action == ADD_ATTRIBUTE:
            by_id[args[0]]["fields"][args[1]] = [args[3], False]
        elif action == SET_REQUIRED:
            by_id[args[0]]["fields"][args[1]][1] = args[2]
        elif action == SET_GATE:
            by_id[args[0]]["gated"] = args[1]
        elif action == PUBLISH:
            self.campaigns[args[0]["id"]] = {"status": "active", "description": args[0]["description"]}
        return {"success": True}

    def rows(self, sql, **params):
        if "FROM user_events" in sql:
            return [
                {"id": e["id"], "event_name": name, "enforce_schema": e["gated"], "field_path": path, "data_type": t, "required": r}
                for name, e in self.events.items() for path, (t, r) in e["fields"].items()
            ]
        if "FROM campaigns" in sql:
            return [{"id": key, **value} for key, value in self.campaigns.items()]
        if "user_metric_definitions" in sql:
            return [{"id": "m_1"}] if self.campaigns else []
        raise AssertionError(sql)


def test_a_second_prepare_signs_in_to_nothing_and_changes_nothing():
    store = Catalog()
    first = prepare(store, 60, store.open_studio)
    assert first.published and first.gate_changed and first.campaign_id == "sim_abandoned_cart_60s"
    assert store.calls.count(CREATE_EVENT) == len(CATALOG) and store.calls.count(PUBLISH) == 1

    calls, events, campaigns = list(store.calls), repr(store.events), repr(store.campaigns)
    second = prepare(store, 60, store.open_studio)
    assert (store.calls, repr(store.events), repr(store.campaigns), store.sign_ins) == (calls, events, campaigns, 1)
    assert second.writes == () and not second.published


def test_another_window_publishes_its_own_campaign_and_leaves_the_first():
    store = Catalog()
    prepare(store, 60, store.open_studio)
    prepare(store, 90, store.open_studio)
    assert set(store.campaigns) == {"sim_abandoned_cart_60s", "sim_abandoned_cart_90s"}
    assert store.calls.count(CREATE_EVENT) == len(CATALOG)


def test_prepare_repairs_drift_with_the_smallest_writes():
    store = Catalog()
    prepare(store, 60, store.open_studio)
    store.events[GATED_EVENT]["gated"] = False
    store.campaigns["sim_abandoned_cart_60s"]["status"] = "paused"
    del store.events["sim_purchase"]["fields"]["order"]
    store.calls.clear()
    prepare(store, 60, store.open_studio)
    assert sorted(store.calls) == sorted([ADD_ATTRIBUTE, SET_GATE, PUBLISH])


def test_an_attribute_of_another_type_fails_its_fixture_by_name():
    stored = Stored({"sim_login": StoredEvent("ue_1", False, {"run_id": ("string", False), "method": ("number", False)})}, {})
    with pytest.raises(FixtureError, match="catalog event sim_login: attribute method is number"):
        plan(CATALOG, [], stored)


def test_a_studio_failure_names_the_fixture():
    store = Catalog()

    def refuse(actions):
        raise StudioError("sign-in: studio refused the sign-in with access_denied")

    with pytest.raises(FixtureError, match="catalog event sim_view_page: sign-in: studio refused"):
        prepare(store, 60, refuse)


def test_no_live_metric_definition_fails_prepare():
    store = Catalog()
    prepare(store, 60, store.open_studio)
    store.rows = lambda sql, **params: [] if "user_metric_definitions" in sql else Catalog.rows(store, sql, **params)
    with pytest.raises(FixtureError, match="metric definition: no LIVE definition counts sim_add_to_cart"):
        prepare(store, 60, store.open_studio)


def nodes(node):
    yield node
    for key in ("next", "success", "timeout", "yes", "no"):
        child = node.get(key)
        for item in child if isinstance(child, list) else [child] if isinstance(child, dict) else []:
            yield from nodes(item)


def test_the_campaign_payload_follows_the_publish_parsers_rules():
    # The rules of studio/src/entities/journey/model/parseCampaign.ts that this journey touches.
    payload = abandoned_cart(60)
    root = payload["root"]
    assert payload["id"] == payload["name"] == campaign_id(60) and payload["id"].startswith("sim_")
    tree = [node for node in nodes(root) if "type" in node and node["type"] in {"setup", "watch", "engagement", "end"}]
    assert root["type"] == "setup" and [node["type"] for node in tree].count("setup") == 1
    ids = [node["id"] for node in tree]
    assert len(ids) == len(set(ids))
    catalog = {event.name for event in CATALOG}
    for node in tree:
        if node["type"] != "end":
            assert isinstance(node["label"], str)
    assert root["triggerEventName"] in catalog and isinstance(root["description"], str)
    [condition] = root["conditions"]["groups"][0]["conditions"]
    assert condition["event"] in catalog and condition["window"]["unit"] in {"SECONDS", "MINUTES", "HOURS", "DAYS", "WEEKS", "MONTHS"}
    assert condition["op"] in {">", ">=", "<", "<=", "=", "!="} and condition["value"] >= 1
    [watch] = [node for node in tree if node["type"] == "watch"]
    assert watch["eventName"] in catalog and watch["timeLimitValue"] == 60
    assert watch["timeLimitUnit"] in {"seconds", "minutes", "hours", "days"} and watch["next"]["type"] == "SuccessOrTimeoutPath"
    [engagement] = [node for node in tree if node["type"] == "engagement"]
    assert engagement["action"]["type"] == "webhook" and engagement["action"]["method"] in {"GET", "POST", "PUT", "PATCH", "DELETE"}
    assert urlparse(engagement["action"]["url"]).hostname.endswith(".invalid")


def test_the_parser_still_reads_the_node_types_the_payload_uses():
    parser = (Path(__file__).parents[2] / "studio" / "src" / "entities" / "journey" / "model" / "parseCampaign.ts").read_text(encoding="utf-8")
    for case in ("setup", "watch", "engagement", "end", "SuccessOrTimeoutPath"):
        assert re.search(rf'case "{case}"', parser), case
    assert 'oneOf(fields, "timeLimitUnit", path, ["seconds", "minutes", "hours", "days"]' in parser


def test_every_event_the_model_sends_is_a_catalog_fixture():
    catalog = {event.name for event in CATALOG}
    assert {step.value for step in FUNNEL} <= catalog
    assert all(name.startswith("sim_") for name in catalog)
    assert [event.name for event in CATALOG if event.gated] == [GATED_EVENT]
