import json
from itertools import groupby, islice
import random
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from cdp_sim import load
from cdp_sim.load import Histogram, Limits, LoadOptions, Meter, Parts, Reading, StopGuard, parse_profile
from cdp_sim.model import PERSONAS, Shopper, script, Step
from cdp_sim.report import Report
from cdp_sim.sender import FIRST_SHOPPER, Hit, KeepAliveCollector, Pacer, Sender, Sent, deliver

RUN = "20261107t000000-abcdef"


def profile(**phases):
    values = {"ramp": "0:0", "steady": "0:0", "peak": "0:0", "soak": "0:0"} | phases
    return parse_profile(values)


def test_ramp_climbs_from_zero_and_the_other_phases_hold_their_rate():
    shape = profile(ramp="100:10", peak="300:5")
    assert [phase.name for phase in shape.phases] == ["ramp", "peak"]
    assert shape.duration_s == 15
    assert shape.events_by(5) == pytest.approx(125)
    assert shape.events_by(10) == pytest.approx(500)
    assert shape.events_by(12) == pytest.approx(1100)
    assert shape.events_by(99) == pytest.approx(2000)
    assert shape.index_at(9.9) == 0 and shape.index_at(10) == 1 and shape.index_at(99) == 1


@pytest.mark.parametrize("value", ["3000", "a:600", "-1:600", "3000:-5", "1:2:3"])
def test_a_malformed_phase_is_refused(value):
    with pytest.raises(ValueError, match="--peak"):
        profile(peak=value)


def test_a_profile_that_sends_nothing_is_refused():
    with pytest.raises(ValueError, match="sends nothing"):
        profile(peak="0:600")


def reading(kafka=0.3, postgres=0.3, dead=0, accepted=1000, errors=None):
    return Reading(lag={}, volumes={"kafka": kafka, "postgres": postgres}, errors=errors or {}, dead_letters=dead,
                   parsed=accepted, accepted=accepted)


@pytest.mark.parametrize(
    ("observed", "condition"),
    [(reading(kafka=0.71), "Kafka volume is 71% full"), (reading(postgres=0.9), "Postgres volume is 90% full"),
     (reading(dead=11, accepted=1000), "reached the dead-letter topic")],
)
def test_each_stop_condition_stops_the_run_and_names_itself(observed, condition):
    assert condition in StopGuard(Limits()).check(observed)


def test_a_reading_at_the_limits_does_not_stop_the_run():
    assert StopGuard(Limits()).check(reading(kafka=0.70, postgres=0.70, dead=10, accepted=1000)) is None


def test_the_run_stops_after_three_readings_in_a_row_without_a_volume():
    guard = StopGuard(Limits())
    blind = reading(kafka=None, errors={"kafka": "URLError: refused"})
    assert guard.check(blind) is None
    assert guard.check(blind) is None
    assert guard.check(reading()) is None
    assert guard.check(blind) is None and guard.check(blind) is None
    assert "URLError: refused" in guard.check(blind)


def test_a_volume_that_cannot_be_read_before_sending_keeps_the_run_from_starting():
    guard = StopGuard(Limits())
    assert "cannot read kafka: no reading" in guard.unreadable(reading(kafka=None))
    assert guard.unreadable(reading()) is None


def test_a_dead_run_tail_counts_as_an_unread_dead_letter_gauge():
    guard = StopGuard(Limits())
    blind = Reading(lag={}, volumes={"kafka": 0.3, "postgres": 0.3}, errors={"dead_letters": "the run tail stopped"},
                    dead_letters=None, parsed=0, accepted=1000)
    assert "dead_letters: the run tail stopped" in guard.unreadable(blind)
    assert guard.check(blind) is None and guard.check(blind) is None
    assert "dead_letters" in guard.check(blind)


def test_histogram_percentiles_stay_within_five_percent():
    histogram = Histogram()
    for ms in range(1, 1001):
        histogram.add(ms)
    summary = histogram.summary()
    assert summary["count"] == 1000 and summary["max"] == 1000
    assert summary["p50"] == pytest.approx(500, rel=0.05)
    assert summary["p99"] == pytest.approx(990, rel=0.05)


def test_meter_puts_each_hit_in_the_phase_it_was_released_for_and_each_latency_in_the_phase_it_was_sent_in():
    meter = Meter(profile(steady="10:10", peak="100:10"))
    meter.record(Sent(at=2, events=20, status=200, error=None, elapsed_ms=5, phase=0))
    meter.record(Sent(at=10.01, events=5, status=200, error=None, elapsed_ms=5, phase=0, delay_ms=10))
    meter.record(Sent(at=12, events=25, status=503, error="HTTP 503", elapsed_ms=50, phase=1))
    meter.record(Sent(at=13, events=25, status=None, error="TimeoutError: timed out", elapsed_ms=10000, phase=1))
    meter.latency(sent_at=9, ms=800)
    steady, peak = meter.phases
    assert (steady.events_sent, steady.send_errors, steady.latency_ms.count) == (25, 0, 1)
    assert steady.delay_ms.max == 10
    assert (peak.events_sent, peak.send_errors) == (50, 50)
    assert peak.responses == {"503": 1, "TimeoutError": 1}
    assert meter.accepted == 25


def test_pacer_releases_whole_visits_up_to_the_target_in_posts_and_pixels():
    shape = profile(peak="3000:10")
    pacer = Pacer(RUN, shape, random.Random(7), batch=25, pixel_share=0.05, sample_every=20)
    hits = [*pacer.due(1.0), *pacer.due(2.0)]
    assert {hit.phase for hit in hits} == {0} and hits[-1].due_at == pytest.approx(2.0, abs=0.01)
    events = [event for hit in hits for event in hit.events]
    assert 6000 <= pacer.released == len(events) < 6000 + 30
    assert all(event.name.startswith("sim_") and event.run_id == RUN for event in events)
    assert len({event.event_id for event in events}) == len(events)
    posts, pixels = [hit for hit in hits if hit.kind == "POST"], [hit for hit in hits if hit.kind == "GET"]
    assert pixels and all(len(hit.events) < 25 + 30 for hit in posts)
    assert 0.02 < sum(len(hit.events) for hit in pixels) / len(events) < 0.10
    for hit in hits:
        runs = [device for device, _ in groupby(event.device_id for event in hit.events)]
        assert len(runs) == len(set(runs)), "a visit's events stay together in one hit"
    assert min(int(event.device_id.rsplit("d", 1)[1]) for event in events) == FIRST_SHOPPER
    sampled = sum(len(hit.sampled) for hit in hits)
    assert 0.03 < sampled / len(events) < 0.07


class FakeClient:
    def __init__(self, status=200):
        self.status = status
        self.posts, self.pixels = [], []

    def post(self, events):
        self.posts.append(events)
        return self.status, None if self.status == 200 else f"HTTP {self.status}"

    def pixel(self, event):
        self.pixels.append(event)
        return self.status, None

    def close(self):
        pass


def test_a_release_that_crosses_a_phase_boundary_is_cut_at_the_boundary():
    shape = profile(steady="100:1", peak="1000:1")
    pacer = Pacer(RUN, shape, random.Random(3), batch=25, pixel_share=0.0, sample_every=20)
    hits = list(pacer.due(1.5))
    steady = sum(len(hit.events) for hit in hits if hit.phase == 0)
    assert 100 <= steady < 100 + 30
    assert all(hit.due_at <= 1.0 for hit in hits if hit.phase == 0)
    assert all(1.0 < hit.due_at <= 1.5 + 0.03 for hit in hits if hit.phase == 1)
    assert [hit.phase for hit in hits] == sorted(hit.phase for hit in hits)


class SlowClient(FakeClient):
    """A collector that takes 50 ms a request: one connection accepts about 500 events a second. It records how many
    events the pacer had built but the collector had not yet taken."""

    def __init__(self, pacer):
        super().__init__()
        self.pacer, self.taken, self.most_unsent = pacer, 0, 0

    def post(self, events):
        self.most_unsent = max(self.most_unsent, self.pacer.released - self.taken)
        time.sleep(0.05)
        self.taken += len(events)
        return super().post(events)


def test_a_collector_slower_than_the_target_leaves_the_pacer_holding_a_count_not_hits():
    shape = profile(peak="3000:3")
    pacer = Pacer(RUN, shape, random.Random(5), batch=25, pixel_share=0.0, sample_every=20)
    client, backpressure, started = SlowClient(pacer), [], time.monotonic()
    sender = Sender(pacer, lambda: client, 1, lambda sent: None, lambda event_id, at: None,
                    lambda at, waited: backpressure.append(waited), lambda: time.monotonic() - started)
    sender.start()
    sender.join()
    assert client.most_unsent <= 5 * (25 + 30), "built hits never exceed the queue, the worker, and the one waiting"
    assert pacer.owed(3.0) > 3000, "what the collector could not take stays a count"
    assert sum(backpressure) > 2.0
    assert time.monotonic() - started < 3 + 1 + 1, "hits still waiting a second after the profile's end are dropped"


def test_a_late_release_is_due_when_its_events_were_due_not_when_it_went_out():
    pacer = Pacer(RUN, profile(peak="1000:10"), random.Random(2), batch=25, pixel_share=0.0, sample_every=20)
    first = list(islice(pacer.due(2.0), 10))
    assert pacer.released < 10 * (25 + 30)
    assert first[-1].due_at == pytest.approx(pacer.released / 1000, abs=0.001)
    assert pacer.owed(2.0) == pytest.approx(2000 - pacer.released)


def test_visits_built_into_a_batch_that_was_never_handed_out_are_owed_again():
    pacer = Pacer(RUN, profile(peak="1000:10"), random.Random(2), batch=25, pixel_share=0.5, sample_every=20)
    hits = pacer.due(2.0)
    handed = [next(hits) for _ in range(6)]
    hits.close()
    assert pacer.released == sum(len(hit.events) for hit in handed)


def test_a_sampled_pixel_is_timed_from_its_own_request_not_from_the_start_of_its_visit():
    events = tuple(script(Shopper(RUN, 1, PERSONAS[1]), (Step.VIEW_PAGE, Step.VIEW_PRODUCT, Step.ADD_TO_CART)))
    ticks, timed = iter(range(100)), []
    hit = Hit("GET", events, sampled=(events[0].event_id, events[2].event_id))
    sent = list(deliver(FakeClient(), hit, lambda: float(next(ticks)), lambda event_id, at: timed.append((event_id, at))))
    assert timed == [(events[0].event_id, sent[0].at), (events[2].event_id, sent[2].at)]
    assert sent[2].at > sent[0].at


def test_a_pixel_visit_is_one_request_per_event_in_order():
    events = tuple(script(Shopper(RUN, 1, PERSONAS[1]), (Step.VIEW_PAGE, Step.VIEW_PRODUCT, Step.ADD_TO_CART)))
    client = FakeClient()
    sent = list(deliver(client, Hit("GET", events), lambda: 0.0, lambda event_id, at: None))
    assert [s.events for s in sent] == [1, 1, 1] and client.pixels == list(events)
    assert list(deliver(client, Hit("POST", events), lambda: 0.0, lambda event_id, at: None))[0].events == 3


class FakeTail:
    """A pipeline that parses every accepted event at once and reads each sampled one 40 ms after it was sent."""

    def __init__(self, meter, now):
        self.meter, self.now = meter, now
        self.behind, self.error = 0, None

    @property
    def counts(self):
        return {"snowplow-parsed": self.meter.accepted, "snowplow-parsed-dead-letters": 0}

    def start(self):
        pass

    def sent_at(self, event_id, at):
        self.meter.latency(at, 40.0)

    def stop(self):
        pass


def fake_parts(client, readings):
    observed = iter(readings)

    def read(meter, tail):
        return next(observed, readings[-1])

    return Parts(connect=lambda: client, tail=FakeTail, read=read)


def options(**phases):
    return LoadOptions(profile(**phases), connections=4, interval_s=0.2, drain_s=1.0, seed=1)


def report_of(result):
    report = Report(run_id=RUN, mode="load", parameters={}, started_at="")
    report.phases, report.expectations, report.samples = result.phases, result.checks, result.samples
    return report


def test_a_healthy_run_passes_every_phase_and_reports_its_measurements():
    client = FakeClient()
    # Visits stay whole, so the visit that crosses into the next phase counts toward the earlier one. At 4,800 peak
    # events that is well under the 1% a phase may fall short.
    result = load.run(options(ramp="4000:0.6", peak="8000:0.6"), RUN, fake_parts(client, [reading()]), log=lambda _: None)
    report = report_of(result)
    assert report.verdict == "pass", report.summary()
    ramp, peak = result.phases
    assert peak.metrics["achieved_share"] >= 0.99 and peak.metrics["send_errors"] == 0
    assert peak.metrics["latency_to_parsed_ms"]["p50"] == pytest.approx(40, rel=0.05)
    assert peak.metrics["sender"]["backpressure_s"] == 0
    assert result.checks[1].evidence["missing"] == 0
    assert len(result.samples) >= 3
    json.dumps(report.to_dict())


def test_a_tripped_stop_condition_aborts_and_leaves_later_phases_not_run():
    client = FakeClient()
    readings = [reading(), reading(kafka=0.75)]
    result = load.run(options(steady="200:0.6", peak="200:5"), RUN, fake_parts(client, readings), log=lambda _: None)
    steady, peak = result.phases
    assert steady.result == "fail" and "Kafka volume is 75% full" in steady.reason
    assert peak.result == "not run"
    assert result.checks[0].result == "fail" and "Kafka volume" in result.checks[0].reason
    assert report_of(result).verdict == "fail"


def test_a_volume_that_cannot_be_read_stops_the_run_before_it_sends():
    client = FakeClient()
    result = load.run(options(peak="200:5"), RUN, fake_parts(client, [reading(kafka=None)]), log=lambda _: None)
    assert client.posts == [] and client.pixels == []
    assert [phase.result for phase in result.phases] == ["not run"]
    assert report_of(result).verdict == "incomplete"


def test_send_errors_fail_the_phase():
    result = load.run(options(peak="200:0.6"), RUN, fake_parts(FakeClient(503), [reading()]), log=lambda _: None)
    (peak,) = result.phases
    assert peak.result == "fail" and "send errors 100.00%" in peak.reason


def test_a_busy_collector_is_named_as_the_limiter():
    metrics = {"sender": {"backpressure_s": 12.5, "cpu_cores": 0.2}}
    assert load.limiter(metrics).startswith("the collector")
    assert load.limiter({"sender": {"backpressure_s": 0, "cpu_cores": 0.95}}).startswith("the sender")


def test_keep_alive_collector_reuses_one_connection():
    connections = []

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def setup(self):
            super().setup()
            connections.append(self.client_address)

        def do_POST(self):
            self.rfile.read(int(self.headers["Content-Length"]))
            self.send_response(200)
            self.send_header("Content-Length", "0")
            self.end_headers()

        do_GET = do_POST

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        client = KeepAliveCollector(f"http://127.0.0.1:{server.server_port}")
        events = tuple(script(Shopper(RUN, 1, PERSONAS[0]), (Step.VIEW_PAGE, Step.VIEW_PRODUCT)))
        assert client.post(events) == (200, None)
        assert client.post(events) == (200, None)
        client.close()
    finally:
        server.shutdown()
    assert len(connections) == 1


def test_a_load_run_whose_fixtures_fail_marks_every_phase_not_run(monkeypatch, capsys):
    from cdp_sim import __main__ as cli

    def refuse(*_, **__):
        raise RuntimeError("Postgres: PGHOST not set")

    monkeypatch.setattr(cli.Database, "connect", refuse)
    monkeypatch.delenv("SIM_REPORT_BUCKET", raising=False)
    assert cli.main(["load", "--ramp", "10:5", "--steady", "0:0", "--soak", "0:0"]) == 3
    out = capsys.readouterr().out
    report = json.loads(out.split(cli.REPORT_BEGIN)[1].split(cli.REPORT_END)[0])
    assert [(phase["phase"], phase["result"]) for phase in report["phases"]] == [("ramp", "not run"), ("peak", "not run")]
    assert report["parameters"]["load"]["phases"][1] == {"phase": "peak", "eps": 3000.0, "duration_s": 600.0,
                                                         "start_eps": 3000.0}
    assert "peak 3000 eps x 600 s (fixtures failed: RuntimeError: Postgres: PGHOST not set)" in out


def test_a_reading_that_hangs_counts_as_unread_so_the_stop_guard_still_stops_the_run():
    released, calls = threading.Event(), []

    def read(meter, tail):
        calls.append(time.monotonic())
        if len(calls) > 1:
            released.wait(10)
        return reading()

    parts = Parts(connect=lambda: FakeClient(), tail=FakeTail, read=read)
    opts = LoadOptions(profile(peak="200:8"), connections=4, interval_s=0.2, drain_s=0.5, reading_deadline_s=0.3,
                       seed=1)
    started = time.monotonic()
    try:
        result = load.run(opts, RUN, parts, log=lambda _: None)
    finally:
        released.set()
    assert time.monotonic() - started < 4, "the guard stopped the run instead of waiting on the hung reading"
    stop = result.checks[0]
    assert stop.result == "fail" and "did not finish within 0.3 s" in stop.reason
    assert "3 readings in a row" in stop.reason
    assert len(calls) == 2, "no reading starts while the last one still hangs"
    (peak,) = result.phases
    assert peak.result == "fail"


def test_the_pacer_is_not_held_to_one_queue_of_hits_per_tick():
    shape = profile(peak="8000:1")
    pacer = Pacer(RUN, shape, random.Random(4), batch=25, pixel_share=0.0, sample_every=20)
    client, backpressure, started = FakeClient(), [], time.monotonic()
    sender = Sender(pacer, lambda: client, 1, lambda sent: None, lambda event_id, at: None,
                    lambda at, waited: backpressure.append(waited), lambda: time.monotonic() - started)
    sender.start()
    sender.join()
    assert pacer.released >= 8000
    assert sum(backpressure) < 0.2, "an instant collector puts no back pressure on the pacer"
