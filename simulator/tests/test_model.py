import random

from cdp_sim.model import PERSONA_BY_NAME, PRODUCTS, Shopper, Step, browse, new_run_id, script


def visits(persona: str, count: int = 200) -> list[list]:
    rng = random.Random(7)
    return [browse(Shopper("r1", index, PERSONA_BY_NAME[persona]), rng) for index in range(count)]


def test_shopper_ids_embed_the_run_id_so_two_runs_never_share_a_shopper():
    first, second = Shopper("run-a", 0, PERSONA_BY_NAME["buyer"]), Shopper("run-b", 0, PERSONA_BY_NAME["buyer"])
    assert first.device_id == "sim-run-a-d0"
    assert first.user_id == "sim-run-a-u0"
    assert {first.device_id, first.user_id}.isdisjoint({second.device_id, second.user_id})


def test_run_ids_differ_between_runs_started_in_the_same_second():
    assert len({new_run_id() for _ in range(50)}) == 50


def test_every_browsed_event_has_a_sim_name_and_a_unique_event_id():
    events = [event for visit in visits("buyer") + visits("browser") for event in visit]
    assert {event.name.split("_")[0] for event in events} == {"sim"}
    assert len({event.event_id for event in events}) == len(events)


def test_a_browser_never_adds_to_cart_and_a_hesitant_shopper_never_buys():
    browser_names = {event.name for visit in visits("browser") for event in visit}
    hesitant_names = {event.name for visit in visits("hesitant") for event in visit}
    assert "sim_view_product" in browser_names and "sim_add_to_cart" not in browser_names
    assert "sim_add_to_cart" in hesitant_names
    assert hesitant_names.isdisjoint({"sim_begin_checkout", "sim_purchase", "sim_login"})


def test_a_buyer_sends_its_user_id_from_its_login_onward_only():
    for visit in visits("buyer", 20):
        login = [event.name for event in visit].index("sim_login")
        assert all(event.user_id is None for event in visit[:login])
        assert all(event.user_id == visit[0].device_id.replace("-d", "-u") for event in visit[login:])
        assert visit[-1].name == "sim_purchase"


def test_a_returning_buyer_buys_in_two_sessions_on_one_device():
    for visit in visits("returning_buyer", 20):
        assert [event.name for event in visit].count("sim_purchase") == 2
        assert len({event.device_id for event in visit}) == 1


def test_popular_products_get_most_views():
    views = [event.attributes["product"]["sku"] for visit in visits("browser", 2000) for event in visit
             if event.name == "sim_view_product"]
    top_five = {product.sku for product in PRODUCTS[:5]}
    assert sum(sku in top_five for sku in views) / len(views) > 0.4


def test_a_script_logs_in_at_its_login_step():
    events = script(Shopper("r1", 3, PERSONA_BY_NAME["buyer"]), (Step.VIEW_PAGE, Step.LOGIN, Step.ADD_TO_CART))
    assert [event.user_id for event in events] == [None, "sim-r1-u3", "sim-r1-u3"]
    assert events[2].attributes["product"] == {"sku": "SIM-SKU-001", "name": "Sim product 001", "category": "laptops",
                                               "price": 349000}
