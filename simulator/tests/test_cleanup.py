import pytest

from cdp_sim import cleanup
from cdp_sim.cleanup import device_patterns, marked_roots, run_device_transitions, shopper_targets
from cdp_sim.model import device_root, user_root
from cdp_sim.studio import StudioError

RUN = "20261107t125904-8d8367"


def test_only_a_simulator_run_id_makes_a_pattern():
    assert device_patterns([RUN]) == [f"sim-{RUN}-%"]
    for bad in ("%", "", "20261107t125904-8d8367%", "sim", "20261107t125904-8D8367", "x' OR 1=1 --"):
        with pytest.raises(ValueError):
            device_patterns([bad])


def test_roots_are_derived_from_the_runs_own_ids_and_never_taken_from_a_row():
    identities = [
        {"domain_userid": f"sim-{RUN}-d3", "user_id": f"sim-{RUN}-u3", "canon_id": "a-real-persons-root"},
        {"domain_userid": f"sim-{RUN}-d5", "user_id": None, "canon_id": "x"},
        {"domain_userid": "sim-20261107t130341-c2d420-d1", "user_id": "someone@example.com", "canon_id": "y"},
    ]
    roots = marked_roots([RUN], identities)
    assert roots == sorted({device_root(f"sim-{RUN}-d3"), user_root(f"sim-{RUN}-u3"), device_root(f"sim-{RUN}-d5")})
    assert "a-real-persons-root" not in roots


def test_every_delete_is_limited_to_the_run_and_to_sim_fixtures():
    identities = [{"domain_userid": f"sim-{RUN}-d1", "user_id": f"sim-{RUN}-u1"}]
    targets = {target.table: target for target in shopper_targets([RUN], [f"sim-{RUN}-%"], identities)}
    assert set(targets) == {"user_campaign_state_transitions", "user_metrics", "identity_graph"}
    assert targets["user_campaign_state_transitions"].where.startswith("campaign_id LIKE 'sim\_%' AND ")
    assert "event_name LIKE 'sim\_%'" in targets["user_metrics"].where
    assert targets["identity_graph"].where == "domain_userid = ANY(:devices)"
    assert targets["identity_graph"].params == {"devices": [f"sim-{RUN}-d1"]}
    assert targets["user_metrics"].params["roots"] == sorted({device_root(f"sim-{RUN}-d1"), user_root(f"sim-{RUN}-u1")})
    devices = run_device_transitions([f"sim-{RUN}-%"])
    assert devices.where == "campaign_id LIKE 'sim\_%' AND domain_userid LIKE ANY(:patterns)"
    for target in [*targets.values(), devices]:
        assert set(target.params) <= {"patterns", "roots", "devices"}
        assert all(f":{name}" in target.where for name in target.params)


def test_a_run_id_with_a_trailing_newline_is_not_a_run_id():
    with pytest.raises(ValueError):
        device_patterns([RUN + "\n"])


class FakeDatabase:
    """A Postgres stand-in: holds the run's devices and the sim_ fixtures, records each statement, and can fail a
    DELETE. A page of identities honours the keyset and the limit, and a DELETE of identities removes them."""

    def __init__(self, world: dict, writable: bool) -> None:
        self.world = world
        self.writable = writable
        world["connections"].append(self)

    def rows(self, sql: str, **params: object) -> list[dict]:
        if "FROM campaigns" in sql:
            return [{"id": campaign} for campaign in self.world["campaigns"]]
        if "FROM user_events" in sql:
            return [{"id": f"ue_{name}", "event_name": name} for name in self.world["events"]]
        if "count(*)" in sql:
            return [{"n": 2}]
        devices = sorted(device for device in self.world["devices"] if device > params.get("after", ""))
        page = [{"domain_userid": device, "user_id": None} for device in devices[: params.get("n", len(devices))]]
        self.world["pages"].append(len(page))
        return page

    def execute(self, sql: str, **params: object) -> int:
        if not self.writable:
            raise AssertionError("a read-only session wrote")
        self.world["statements"].append(sql.split()[0] + (" " + sql.split()[2] if sql.startswith("DELETE") else ""))
        if sql.startswith("DELETE") and self.world.get("fail_on") and self.world["fail_on"] in sql:
            if len([s for s in self.world["statements"] if s == "COMMIT"]) >= self.world.get("fail_after", 0):
                raise RuntimeError("deadlock")
        if sql.startswith("DELETE FROM identity_graph"):
            self.world["devices"] = [d for d in self.world["devices"] if d not in params["devices"]]
            return len(params["devices"])
        return 0 if "ctid" in sql else 2

    def close(self) -> None:
        pass


class FakeStudio:
    def __init__(self, world: dict, refuses: set[str]) -> None:
        self.world = world
        self.refuses = refuses

    def call(self, action: str, fixture_id: str) -> None:
        if fixture_id in self.refuses:
            raise StudioError(f"{action}: Campaign is in use")
        self.world["campaigns"] = [c for c in self.world["campaigns"] if c != fixture_id]
        self.world["events"] = [e for e in self.world["events"] if f"ue_{e}" != fixture_id]


@pytest.fixture
def world(monkeypatch) -> dict:
    state = {"connections": [], "statements": [], "pages": [], "campaigns": ["sim_cart"], "events": ["sim_view_page"],
             "devices": [f"sim-{RUN}-d{n}" for n in range(1, 13)]}
    monkeypatch.setattr(cleanup, "BATCH", 5, raising=False)

    class Connect:
        @staticmethod
        def connect(writable: bool = False) -> FakeDatabase:
            return FakeDatabase(state, writable)

    monkeypatch.setattr(cleanup, "Database", Connect)
    return state


def never_opened(_actions):
    raise AssertionError("a dry run opened studio")


def test_without_apply_clean_up_only_lists_and_never_writes(world):
    found = cleanup.run([RUN], include_fixtures=True, apply=False, open_studio=never_opened)
    assert found["applied"] is False
    assert found["campaigns"] == ["sim_cart"] and found["catalog_events"] == ["sim_view_page"]
    assert set(found["rows"]) == {"user_campaign_state_transitions", "user_metrics", "identity_graph"}
    assert "deleted" not in found
    assert world["statements"] == []
    assert not any(connection.writable for connection in world["connections"])
    assert world["campaigns"] == ["sim_cart"]


def test_clean_up_reads_and_deletes_the_runs_devices_in_bounded_batches_each_its_own_transaction(world):
    found = cleanup.run([RUN], include_fixtures=False, apply=True, open_studio=never_opened)
    assert max(world["pages"]) <= 5, "no read holds more than one batch of identities"
    assert world["devices"] == []
    assert found["deleted"]["identity_graph"] == 12
    batch = ["BEGIN", "DELETE user_campaign_state_transitions", "DELETE user_metrics", "DELETE identity_graph", "COMMIT"]
    by_device = ["BEGIN", "DELETE user_campaign_state_transitions", "COMMIT"]
    assert world["statements"] == by_device + batch * 3


def test_a_dry_run_counts_every_batch(world):
    found = cleanup.run([RUN], include_fixtures=False, apply=False, open_studio=never_opened)
    assert max(world["pages"]) <= 5
    assert found["rows"] == {"user_campaign_state_transitions": 2 + 3 * 2, "user_metrics": 3 * 2, "identity_graph": 3 * 2}


def test_a_failed_delete_rolls_back_its_batch_and_touches_no_fixture(world):
    world["fail_on"], world["fail_after"] = "user_metrics", 2
    with pytest.raises(RuntimeError, match="deadlock"):
        cleanup.run([RUN], include_fixtures=True, apply=True, open_studio=never_opened)
    assert world["statements"][-1] == "ROLLBACK"
    assert world["statements"].count("COMMIT") == 2, "batches before the failure stay deleted; a rerun finishes"
    assert len(world["devices"]) == 12 - 5
    assert world["campaigns"] == ["sim_cart"]


def test_applied_clean_up_commits_and_reports_nothing_left(world):
    found = cleanup.run([RUN], include_fixtures=True, apply=True, open_studio=lambda _: FakeStudio(world, set()))
    assert world["statements"][0] == "BEGIN" and world["statements"][-1] == "COMMIT"
    assert found["not_deleted"] == {"campaigns": [], "catalog_events": [], "errors": []}
    assert not cleanup.incomplete(found)


def test_a_fixture_studio_would_not_delete_is_reported_as_left(world):
    found = cleanup.run([RUN], include_fixtures=True, apply=True, open_studio=lambda _: FakeStudio(world, {"sim_cart"}))
    assert found["not_deleted"]["campaigns"] == ["sim_cart"]
    assert found["not_deleted"]["catalog_events"] == []
    assert found["not_deleted"]["errors"] == ["deleteCampaignAction: Campaign is in use"]
    assert cleanup.incomplete(found)
