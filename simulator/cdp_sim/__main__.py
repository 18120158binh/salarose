"""`python -m cdp_sim smoke|logical|load|bench|cleanup`.

smoke, logical, load, and bench: one run, its report on stdout and in object storage. Exit status 0 pass, 1 fail, 3 incomplete.
cleanup: lists, and with --apply removes, the rows of the given runs and, with --fixtures, every sim_ fixture.
"""

from __future__ import annotations

import argparse
import json
import signal
import sys
from datetime import datetime, timezone

from cdp_sim import bench, cleanup, load, logical, smoke
from cdp_sim.cluster import LiveCluster
from cdp_sim.db import Database
from cdp_sim.fixtures import FixtureError, prepare
from cdp_sim.gauges import deployment_parts
from cdp_sim.model import new_run_id
from cdp_sim.readiness import await_gate, await_graph
from cdp_sim.report import ExpectationResult, Report, store
from cdp_sim.settings import Settings
from cdp_sim.studio import Studio, StudioError, service_account
from cdp_sim.tracker import Collector

# Ramp to the average daily rate (SIM-NFR-04, 25 million a day), hold it, peak at 3,000 for 10 minutes (SIM-NFR-03),
# then soak an hour at the average while the backlog drains.
DEFAULT_PROFILE = {"ramp": "290:300", "steady": "290:600", "peak": "3000:600", "soak": "290:3600"}
EXIT_STATUS = {"pass": 0, "fail": 1, "incomplete": 3}
REPORT_BEGIN, REPORT_END = "----- BEGIN SIM REPORT -----", "----- END SIM REPORT -----"


def studio_opener(settings: Settings):
    def open_studio(actions: set[str]) -> Studio:
        if not settings.studio_url:
            raise StudioError("SIM_STUDIO_URL is not set")
        studio = Studio(settings.studio_url)
        studio.sign_in(service_account(settings.login_secret_id, settings.login_secret_entry))
        studio.discover(actions)
        return studio

    return open_studio


def run(mode: str, settings: Settings, load_options: load.LoadOptions | None = None,
        bench_options: bench.BenchOptions | None = None) -> int:
    run_id = new_run_id()
    parameters = {
        "collector_url": settings.collector_url,
        "kafka_brokers": settings.kafka_brokers,
        "studio_url": settings.studio_url,
        "stage_timeout_s": settings.stage_timeout_s,
        "scenario_window_s": settings.scenario_window_s,
    }
    if load_options is not None:
        parameters |= {"load": load_options.parameters(), "prometheus_url": settings.prometheus_url,
                       "volume_query": settings.volume_query, "pg_volume_bytes": settings.pg_volume_bytes}
    if bench_options is not None:
        parameters |= {"bench": bench_options.parameters(), "prometheus_url": settings.prometheus_url,
                       "volume_query": settings.volume_query, "pg_volume_bytes": settings.pg_volume_bytes}
    report = Report(run_id=run_id, mode=mode, parameters=parameters, started_at=datetime.now(timezone.utc).isoformat())
    print(f"run {run_id} mode={mode} started", flush=True)
    db = None
    try:
        db = Database.connect()
        fixtures = prepare(db, settings.scenario_window_s, studio_opener(settings))
        collector = Collector(settings.collector_url)
        readiness = {}
        if fixtures.published:
            readiness["graph"] = await_graph(collector, db, fixtures, run_id)
        if fixtures.gate_changed and mode == "logical":
            readiness["gate"] = await_gate(collector, settings.kafka_brokers, run_id)
        report.fixtures = {
            "campaign_id": fixtures.campaign_id,
            "metric_definition_id": fixtures.metric_definition_id,
            "gated_event": fixtures.gated_event,
            "writes": list(fixtures.writes),
            "readiness": readiness,
        }
        print(f"fixtures ready: {len(fixtures.writes)} studio writes", flush=True)
    except Exception as error:  # noqa: BLE001  Any fixture failure stops the run before its shoppers send anything.
        message = str(error) if isinstance(error, FixtureError) else f"{type(error).__name__}: {error}"
        report.fixtures = {"error": message}
        if mode == "smoke":
            report.stages = smoke.not_reached(list(smoke.STAGES), f"fixtures failed: {message}")
        elif load_options is not None:
            report.phases = load.not_run(load_options.profile, f"fixtures failed: {message}")
        elif bench_options is not None:
            report.expectations = [ExpectationResult("bench", "The sim_ fixtures exist", ("SIM-FR-05",), "not run",
                                                     reason=f"fixtures failed: {message}")]
        else:
            report.expectations = [ExpectationResult("all", "The sim_ fixtures exist", ("SIM-FR-05",), "not run",
                                                     reason=f"fixtures failed: {message}")]
    else:
        if mode == "smoke":
            report.stages = smoke.run(settings, fixtures, db, run_id)
        elif load_options is not None:
            result = load.run(load_options, run_id, deployment_parts(settings, db, run_id))
            report.phases, report.expectations, report.samples = result.phases, result.checks, result.samples
        elif bench_options is not None:
            result = bench.run(bench_options, run_id, LiveCluster(settings, db, run_id))
            report.phases, report.expectations, report.samples = result.runs, result.checks, result.samples
            report.measurements = result.measurements
        else:
            report.expectations = logical.run(settings, fixtures, db, run_id)
    finally:
        if db is not None:
            db.close()
    report.ended_at = datetime.now(timezone.utc).isoformat()
    report.storage = store(report, settings.report_bucket)
    print(REPORT_BEGIN, report.to_json(), REPORT_END, report.summary(), sep="\n", flush=True)
    return EXIT_STATUS[report.verdict]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="cdp_sim", description="Drive the journey engine with simulated shoppers.")
    modes = parser.add_subparsers(dest="mode", required=True)
    modes.add_parser("smoke", help="follow one shopper through every stage")
    modes.add_parser("logical", help="play every logical scenario")
    loads = modes.add_parser("load", help="send shoppers at a rate profile and measure each phase")
    for name, default in DEFAULT_PROFILE.items():
        loads.add_argument(f"--{name}", default=default, metavar="EPS:SECONDS",
                           help=f"the {name} phase's events per second and duration; 0 seconds skips it (default {default})")
    loads.add_argument("--batch", type=int, default=25, help="events per POST, in whole visits (default 25)")
    loads.add_argument("--pixel-share", type=float, default=0.05, help="share of visits sent as GET pixels (default 0.05)")
    loads.add_argument("--connections", type=int, default=32, help="concurrent collector connections (default 32)")
    loads.add_argument("--sample-every", type=int, default=20, help="time one event in N to snowplow-parsed (default 20)")
    loads.add_argument("--interval", type=float, default=15.0, help="seconds between readings (default 15)")
    loads.add_argument("--drain", type=float, default=300.0, help="seconds to wait for the last events after sending (default 300)")
    benches = modes.add_parser("bench", help="measure one Flink job's drain rate by suspend, fill, and resume")
    benches.add_argument("--job", required=True, choices=sorted(bench.JOBS), help="the job to measure")
    benches.add_argument("--backlog", type=int, required=True, help="input records to drain in each run")
    benches.add_argument("--runs", type=int, default=5, help="measured runs (default 5)")
    benches.add_argument("--fill-eps", type=float, default=1000.0, help="events per second while filling (default 1000)")
    benches.add_argument("--probe-backlog", type=int, default=20_000,
                         help="the first run's backlog, which measures WAL per record and is not counted (default 20000)")
    benches.add_argument("--batch", type=int, default=25, help="events per POST, in whole visits (default 25)")
    benches.add_argument("--connections", type=int, default=32, help="concurrent collector connections (default 32)")
    benches.add_argument("--interval", type=float, default=5.0, help="seconds between readings (default 5)")
    benches.add_argument("--settle", type=float, default=60.0,
                         help="seconds the input topic's end must hold still before the resume (default 60)")
    benches.add_argument("--fill-timeout", type=float, default=3600.0, help="longest fill, in seconds (default 3600)")
    benches.add_argument("--drain-timeout", type=float, default=3600.0, help="longest drain, in seconds (default 3600)")
    clean = modes.add_parser("cleanup", help="list, or with --apply remove, what runs left behind")
    clean.add_argument("--run", dest="run_ids", action="append", required=True, help="a run id; repeat for several")
    clean.add_argument("--fixtures", action="store_true", help="also every sim_ campaign and catalog event")
    clean.add_argument("--apply", action="store_true", help="delete; without it, only list")
    args = parser.parse_args(argv)
    settings = Settings.from_environment()
    if args.mode == "cleanup":
        found = cleanup.run(args.run_ids, args.fixtures, args.apply, studio_opener(settings))
        print(json.dumps(found, indent=2, default=str), flush=True)
        return 1 if cleanup.incomplete(found) else 0
    if args.mode == "load":
        return run(args.mode, settings, load_options(parser, args))
    if args.mode == "bench":
        # The Job's deadline sends SIGTERM. Raising SystemExit lets the bench resume the job and report what it left.
        signal.signal(signal.SIGTERM, lambda signum, frame: sys.exit(128 + signum))
        return run(args.mode, settings, bench_options=bench_options(parser, args))
    return run(args.mode, settings)


def load_options(parser: argparse.ArgumentParser, args: argparse.Namespace) -> load.LoadOptions:
    try:
        profile = load.parse_profile({name: getattr(args, name) for name in load.PHASE_NAMES})
    except ValueError as error:
        parser.error(str(error))
    if args.batch < 1 or args.connections < 1 or args.sample_every < 1 or args.interval <= 0 or args.drain < 0:
        parser.error("--batch, --connections, and --sample-every must be 1 or more, --interval positive, --drain 0 or more")
    if not 0 <= args.pixel_share <= 1:
        parser.error("--pixel-share must be between 0 and 1")
    return load.LoadOptions(profile, batch=args.batch, pixel_share=args.pixel_share, connections=args.connections,
                            sample_every=args.sample_every, interval_s=args.interval, drain_s=args.drain)


def bench_options(parser: argparse.ArgumentParser, args: argparse.Namespace) -> bench.BenchOptions:
    if min(args.backlog, args.runs, args.probe_backlog, args.batch, args.connections) < 1:
        parser.error("--backlog, --runs, --probe-backlog, --batch, and --connections must be 1 or more")
    if min(args.fill_eps, args.interval, args.fill_timeout, args.drain_timeout) <= 0 or args.settle < 0:
        parser.error("--fill-eps, --interval, --fill-timeout, and --drain-timeout must be positive, --settle 0 or more")
    return bench.BenchOptions(bench.JOBS[args.job], args.backlog, runs=args.runs, fill_eps=args.fill_eps,
                              probe_backlog=args.probe_backlog, batch=args.batch, connections=args.connections,
                              interval_s=args.interval, settle_s=args.settle, fill_timeout_s=args.fill_timeout,
                              drain_timeout_s=args.drain_timeout)


if __name__ == "__main__":
    sys.exit(main())
