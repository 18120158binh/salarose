import base64
import json
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from cdp_sim.model import TrackedEvent
from cdp_sim.tracker import Collector, post_body, pixel_query

EVENT = TrackedEvent(
    run_id="r1",
    device_id="sim-r1-d0",
    user_id="sim-r1-u0",
    event_id="5f0c1a2e-8a51-4c4e-9d1b-1d2f3e4a5b6c",
    timestamp_ms=1760346764120,
    name="sim_add_to_cart",
    attributes={"product": {"sku": "SIM-SKU-001", "price": 349000}},
)
RUN_ENTITY = {
    "schema": "iglu:com.snowplowanalytics.snowplow/contexts/jsonschema/1-0-1",
    "data": [{"schema": "iglu:io.cdp.sim/run/jsonschema/1-0-0", "data": {"run_id": "r1"}}],
}


def test_a_post_body_carries_each_event_as_a_self_describing_event_with_the_run_id():
    body = json.loads(post_body([EVENT]))
    assert body["schema"] == "iglu:com.snowplowanalytics.snowplow/payload_data/jsonschema/1-0-4"
    [params] = body["data"]
    assert {key: params[key] for key in ("e", "eid", "duid", "uid", "ttm", "aid")} == {
        "e": "ue", "eid": EVENT.event_id, "duid": "sim-r1-d0", "uid": "sim-r1-u0", "ttm": "1760346764120", "aid": "cdp-sim",
    }
    assert json.loads(params["ue_pr"])["data"] == {
        "schema": "iglu:io.cdp.sim/sim_add_to_cart/jsonschema/1-0-0",
        "data": {"event_name": "sim_add_to_cart", "run_id": "r1", "product": {"sku": "SIM-SKU-001", "price": 349000}},
    }
    assert json.loads(params["co"]) == RUN_ENTITY


def test_an_invalid_event_without_an_id_sends_no_eid_and_an_anonymous_one_no_uid():
    [params] = json.loads(post_body([TrackedEvent("r1", "sim-r1-d0", None, None, 1, "sim_view_page")]))["data"]
    assert "eid" not in params and "uid" not in params
    assert params["duid"] == "sim-r1-d0"


def test_a_structured_event_sends_its_se_fields_and_no_self_describing_event():
    event = TrackedEvent("r1", "sim-r1-d0", None, "e1", 1, None, {"se_ca": "sim", "se_ac": "Go", "se_va": 12.5}, True)
    [params] = json.loads(post_body([event]))["data"]
    assert (params["e"], params["se_ca"], params["se_ac"], params["se_va"]) == ("se", "sim", "Go", "12.5")
    assert "ue_pr" not in params


def test_a_pixel_carries_the_same_event_in_base64_fields():
    query = dict(urllib.parse.parse_qsl(pixel_query(EVENT)))
    [post_params] = json.loads(post_body([EVENT]))["data"]
    assert "ue_pr" not in query and "co" not in query
    assert json.loads(base64.urlsafe_b64decode(query.pop("ue_px"))) == json.loads(post_params.pop("ue_pr"))
    assert json.loads(base64.urlsafe_b64decode(query.pop("cx"))) == json.loads(post_params.pop("co"))
    assert query == post_params


class Recorder(BaseHTTPRequestHandler):
    hits: list = []
    status = 200

    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        Recorder.hits.append(("POST", self.path, self.headers["Content-Type"], body))
        self.send_response(Recorder.status)
        self.end_headers()

    def do_GET(self):
        Recorder.hits.append(("GET", self.path, None, b""))
        self.send_response(Recorder.status)
        self.end_headers()

    def log_message(self, *args):
        pass


@pytest.fixture
def collector_url():
    Recorder.hits, Recorder.status = [], 200
    server = HTTPServer(("127.0.0.1", 0), Recorder)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_port}"
    server.shutdown()


def test_the_collector_receives_posts_on_tp2_and_pixels_on_i(collector_url):
    collector = Collector(collector_url)
    post, pixel = collector.post([EVENT]), collector.pixel(EVENT)
    assert (post.ok, post.status, post.event_ids) == (True, 200, (EVENT.event_id,))
    assert (pixel.ok, pixel.method) == (True, "GET")
    (method, path, content_type, body), (get_method, get_path, _, _) = Recorder.hits
    assert (method, path, content_type) == ("POST", "/com.snowplowanalytics.snowplow/tp2", "application/json; charset=UTF-8")
    assert body == post_body([EVENT])
    assert get_path == "/i?" + pixel_query(EVENT)


def test_a_collector_error_is_a_failed_hit_not_an_exception(collector_url):
    Recorder.status = 503
    assert Collector(collector_url).post([EVENT]).ok is False
    unreachable = Collector("http://127.0.0.1:9", timeout_s=2).post([EVENT])
    assert (unreachable.ok, unreachable.status) == (False, None)
    assert unreachable.error
