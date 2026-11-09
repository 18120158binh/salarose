import time

from cdp_sim import journey, logical
from cdp_sim.fixtures import SETUP_NODE, Fixtures
from cdp_sim.model import Step
from cdp_sim.settings import Settings
from cdp_sim.tracker import HitResult

STAGE_TIMEOUT_S = 1.5


class QuietTail:
    def __init__(self, *_: object) -> None:
        pass

    def read_until(self, _deadline: float) -> None:
        pass

    def all(self, _owner) -> dict:
        return {}

    def close(self) -> None:
        pass


def test_the_purchase_is_sent_once_the_buyer_alone_has_entered(monkeypatch):
    posts: list[tuple[float, tuple[str | None, ...]]] = []

    class RecordingCollector:
        def __init__(self, _url: str) -> None:
            pass

        def post(self, events) -> HitResult:
            posts.append((time.monotonic(), tuple(event.name for event in events)))
            return HitResult("POST", tuple(event.event_id for event in events), 200)

    def only_the_buyer_entered(_db, _campaign, shoppers):
        # Shopper 6 is the buyer. The cart shopper and the repeat shopper never enter.
        return [{"domain_userid": s.device_id, "canon_id": "", "node_id": SETUP_NODE} for s in shoppers if s.device_id.endswith("-d6")]

    monkeypatch.setattr(logical, "TopicTail", QuietTail)
    monkeypatch.setattr(logical, "Collector", RecordingCollector)
    monkeypatch.setattr(journey, "transitions", only_the_buyer_entered)
    monkeypatch.setattr(journey, "POLL_S", 0.01)
    for check in ("invalid_event", "structured_event", "identity_stitching", "abandoned_cart", "duplicate_event"):
        monkeypatch.setattr(logical, check, lambda *_, **__: [])
    monkeypatch.setattr(logical, "gated_event", lambda *_, **__: None)
    monkeypatch.setattr(logical, "purchase_cancels", lambda *_, **__: None)
    settings = Settings("http://c", "k:9092", None, None, "s", "e", STAGE_TIMEOUT_S, 1)
    fixtures = Fixtures("sim_cart", "m", "sim_gated", 1)

    started = time.monotonic()
    logical.run(settings, fixtures, None, "20261107t125904-8d8367")

    purchases = [at for at, names in posts if Step.PURCHASE.value in names]
    assert len(purchases) == 1
    assert purchases[0] - started < STAGE_TIMEOUT_S / 3, "the purchase waited for the siblings that never entered"

