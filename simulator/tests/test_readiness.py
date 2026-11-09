import pytest

from cdp_sim import journey, readiness
from cdp_sim.fixtures import SETUP_NODE, FixtureError, Fixtures
from cdp_sim.model import device_root


class Collector:
    def __init__(self) -> None:
        self.sent: list[tuple[str, str]] = []

    def post(self, events):
        self.sent.extend((event.device_id, event.name) for event in events)


class Engine:
    """Holds the graph only from the second probe on: the first trigger was dropped before the rule arrived."""

    def __init__(self, collector: Collector) -> None:
        self.collector = collector

    def rows(self, sql, **params):
        carts = [device for device, name in self.collector.sent if name == "sim_add_to_cart"]
        return [
            {"canon_id": device_root(device), "domain_userid": device, "node_id": SETUP_NODE, "branch": "next"}
            for device in carts[1:]
        ]


@pytest.fixture(autouse=True)
def fast(monkeypatch):
    monkeypatch.setattr(readiness, "GRAPH_PROBE_EVERY_S", 0.0)
    monkeypatch.setattr(readiness, "GRAPH_TIMEOUT_S", 1.0)
    monkeypatch.setattr(journey, "POLL_S", 0.01)


FIXTURES = Fixtures("sim_abandoned_cart_60s", "m_1", "sim_gated_check", 60)


def test_the_graph_is_ready_when_a_probe_shopper_enters_and_the_probe_then_purchases():
    collector = Collector()
    evidence = readiness.await_graph(collector, Engine(collector), FIXTURES, "20261107t125904-8d8367")
    assert evidence["probes_sent"] == 2 and evidence["probe"].endswith("-d901")
    assert collector.sent[-1] == (evidence["probe"], "sim_purchase")


def test_no_probe_entering_fails_the_campaign_fixture():
    collector = Collector()
    never = type("Never", (), {"rows": lambda self, sql, **params: []})()
    with pytest.raises(FixtureError, match="campaign sim_abandoned_cart_60s: no probe shopper entered"):
        readiness.await_graph(collector, never, FIXTURES, "20261107t125904-8d8367")
