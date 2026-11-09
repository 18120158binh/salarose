import json
import threading
from collections import namedtuple
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from kafka import TopicPartition

from cdp_sim import gauges
from cdp_sim.gauges import REQUEST_TIMEOUT_MS, LagProbe, RunCount, RunTail, Volumes, deployment_parts, prometheus_value
from cdp_sim.settings import Settings

RUN = "20261107t000000-abcdef"
Offset = namedtuple("Offset", "offset metadata")


def parsed(event_id, run=RUN):
    return json.dumps({"event_id": event_id, "event_name": "sim_view_page", "run_id": run}).encode()


def test_run_count_counts_only_the_runs_records_and_times_sampled_events():
    latencies = []
    count = RunCount(RUN, lambda sent, ms: latencies.append((sent, ms)), now=lambda: 10.5)
    count.sent_at("e-1", 10.0)
    count.count("snowplow-parsed", parsed("e-1"))
    count.count("snowplow-parsed", parsed("e-2"))
    count.count("snowplow-parsed", parsed("e-3", run="20261107t000000-ffffff"))
    count.count("snowplow-parsed-dead-letters", json.dumps({"event": {"run_id": RUN}}).encode())
    count.count("snowplow-parsed", None)
    assert count.counts == {"snowplow-parsed": 2, "snowplow-parsed-dead-letters": 1}
    assert latencies == [(10.0, 500.0)]
    count.count("snowplow-parsed", parsed("e-1"))
    assert len(latencies) == 1, "a duplicate is counted but timed once"


class FakeAdmin:
    def __init__(self, groups):
        self.groups = groups

    def list_consumer_group_offsets(self, group):
        if isinstance(self.groups[group], Exception):
            raise self.groups[group]
        return self.groups[group]


class FakeConsumer:
    def __init__(self, ends):
        self.ends = ends

    def end_offsets(self, partitions):
        return {partition: self.ends[partition] for partition in partitions}


def test_lag_is_end_minus_committed_over_the_topics_partitions():
    good0, good1 = TopicPartition("snowplow-good", 0), TopicPartition("snowplow-good", 1)
    parsed0, other = TopicPartition("snowplow-parsed", 0), TopicPartition("segment-check", 0)
    matched0 = TopicPartition("journey-engine-matched-events", 0)
    admin = FakeAdmin({
        "event-processor-group": {good0: Offset(90, ""), good1: Offset(-1, "")},
        "customer-decision-events": {parsed0: Offset(10, ""), other: Offset(0, "")},
        "customer-profile-writer": {},
        "campaign-state-machine-group": RuntimeError("coordinator not available"),
    })
    consumer = FakeConsumer({good0: 100, good1: 50, parsed0: 25, other: 1000, matched0: 7})
    lag = LagProbe(admin, consumer).read()
    assert lag == {"snowplow-good": 10, "snowplow-parsed": 15, "customer-profile-mutations": None,
                   "journey-engine-matched-events": None}


class FakeDatabase:
    def __init__(self, size=None):
        self.size = size

    def rows(self, sql, **params):
        if self.size is None:
            raise RuntimeError("permission denied")
        return [{"bytes": self.size}]


def prometheus(body):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            payload = json.dumps(body).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def vector(*values):
    return {"status": "success", "data": {"resultType": "vector",
                                          "result": [{"metric": {}, "value": [0, str(value)]} for value in values]}}


def test_prometheus_value_is_the_largest_series_and_an_empty_result_raises():
    server = prometheus(vector(0.41, 0.52))
    try:
        assert prometheus_value(f"http://127.0.0.1:{server.server_port}", "up") == 0.52
    finally:
        server.shutdown()
    server = prometheus(vector())
    try:
        with pytest.raises(RuntimeError, match="no series"):
            prometheus_value(f"http://127.0.0.1:{server.server_port}", "up")
    finally:
        server.shutdown()


def test_postgres_takes_the_larger_of_the_node_filesystem_and_its_own_size():
    server = prometheus(vector(0.40))
    try:
        url = f"http://127.0.0.1:{server.server_port}"
        assert Volumes(url, "q", FakeDatabase(size=6 * 2**30), 8 * 2**30).read() == ({"kafka": 0.40, "postgres": 0.75}, {})
        ratios, errors = Volumes(url, "q", FakeDatabase(), 8 * 2**30).read()
        assert ratios == {"kafka": 0.40, "postgres": 0.40} and "permission denied" in errors["postgres"]
    finally:
        server.shutdown()


def test_an_unreachable_prometheus_leaves_the_kafka_volume_unread():
    ratios, errors = Volumes("http://127.0.0.1:9", "q", FakeDatabase(size=2**30), 8 * 2**30).read()
    assert ratios == {"kafka": None, "postgres": 0.125}
    assert "data node filesystem" in errors["kafka"]


class RecordingKafka:
    """Stands in for KafkaConsumer and KafkaAdminClient, and records how each was configured."""

    made = []

    def __init__(self, **config):
        self.config = config
        RecordingKafka.made.append(config)

    def partitions_for_topic(self, topic):
        return {0}

    def assign(self, partitions):
        pass

    def end_offsets(self, partitions):
        return {partition: 0 for partition in partitions}

    def seek(self, partition, offset):
        pass


def test_every_kafka_client_of_a_load_run_gives_up_on_a_request_after_ten_seconds(monkeypatch):
    RecordingKafka.made = []
    monkeypatch.setattr(gauges, "KafkaConsumer", RecordingKafka)
    monkeypatch.setattr(gauges, "KafkaAdminClient", RecordingKafka)
    settings = Settings("http://collector", "kafka:9092", None, None, "id", "entry", 45.0, 60)
    deployment_parts(settings, FakeDatabase(size=1), RUN)
    RunTail("kafka:9092", RUN, f"sim-{RUN}-load", lambda sent, ms: None, lambda: 0.0)
    assert REQUEST_TIMEOUT_MS == 10_000
    assert len(RecordingKafka.made) == 3
    assert all(config["request_timeout_ms"] == REQUEST_TIMEOUT_MS for config in RecordingKafka.made)


def test_the_run_tail_heartbeats_within_a_third_of_its_session_so_kafka_python_does_not_warn(monkeypatch):
    RecordingKafka.made = []
    monkeypatch.setattr(gauges, "KafkaConsumer", RecordingKafka)
    RunTail("kafka:9092", RUN, f"sim-{RUN}-load", lambda sent, ms: None, lambda: 0.0)
    [config] = RecordingKafka.made
    assert config["heartbeat_interval_ms"] * 3 <= config["session_timeout_ms"]
