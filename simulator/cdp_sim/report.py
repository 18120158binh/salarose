"""The run report (SIM-FR-16) and where it is kept (SIM-FR-19)."""

from __future__ import annotations

import json
import statistics
from dataclasses import asdict, dataclass, field
from typing import Literal

StageOutcome = Literal["pass", "fail", "not reached"]
ExpectationOutcome = Literal["pass", "fail", "expected failure", "not run"]
# As the contract's Behavior defines them: `incomplete` when nothing failed but a stage or an expectation could not run.
Verdict = Literal["pass", "fail", "incomplete"]


@dataclass(frozen=True)
class StageResult:
    stage: str
    result: StageOutcome
    evidence: dict = field(default_factory=dict)
    reason: str | None = None
    seconds: float | None = None


@dataclass(frozen=True)
class ExpectationResult:
    scenario: str
    expectation: str
    requirements: tuple[str, ...]
    result: ExpectationOutcome
    evidence: dict = field(default_factory=dict)
    reason: str | None = None
    known_issue: str | None = None


PhaseOutcome = Literal["pass", "fail", "not run"]


@dataclass(frozen=True)
class PhaseResult:
    """One phase of a load run: its target, and what it measured (SIM-FR-11)."""

    phase: str
    result: PhaseOutcome
    target: dict
    metrics: dict = field(default_factory=dict)
    reason: str | None = None


MeasurementOutcome = Literal["measured", "inconclusive"]


@dataclass(frozen=True)
class Measurement:
    """One bench number over its runs (SIM-FR-22): its unit, every run's value, the median and range, and the limiter
    the runs named from their metrics. Without one limiter common to every run, the number is inconclusive."""

    name: str
    unit: str
    values: tuple[float, ...]
    limiters: tuple[str | None, ...]

    @property
    def runs(self) -> int:
        return len(self.values)

    @property
    def median(self) -> float | None:
        return statistics.median(self.values) if self.values else None

    @property
    def range(self) -> tuple[float, float] | None:
        return (min(self.values), max(self.values)) if self.values else None

    @property
    def limiter(self) -> str | None:
        named = set(self.limiters)
        return named.pop() if len(named) == 1 and None not in named else None

    @property
    def result(self) -> MeasurementOutcome:
        return "measured" if self.values and self.limiter else "inconclusive"

    def to_dict(self) -> dict:
        return {"name": self.name, "unit": self.unit, "result": self.result, "runs": self.runs,
                "median": self.median, "range": self.range, "limiter": self.limiter, "values": list(self.values),
                "limiters": list(self.limiters)}

    def line(self) -> str:
        if not self.values:
            return f"{self.name}: no run finished"
        low, high = self.range
        limiter = self.limiter or "inconclusive, the runs named " + "; ".join(sorted({str(l) for l in self.limiters}))
        return (f"{self.name}: median {self.median:.1f} {self.unit}, range {low:.1f} to {high:.1f}, {self.runs} runs,"
                f" limiter {limiter}")


@dataclass
class Report:
    run_id: str
    mode: str
    parameters: dict
    started_at: str
    ended_at: str = ""
    stages: list[StageResult] = field(default_factory=list)
    expectations: list[ExpectationResult] = field(default_factory=list)
    phases: list[PhaseResult] = field(default_factory=list)
    # A load run's timeline: one entry per interval, as it printed them while it ran (SIM-NFR-05).
    samples: list[dict] = field(default_factory=list)
    # A bench run's numbers (SIM-FR-22).
    measurements: list[Measurement] = field(default_factory=list)
    # What prepare did: the studio writes it made, the readiness probes, or the fixture that failed and why.
    fixtures: dict = field(default_factory=dict)
    storage: dict = field(default_factory=dict)

    @property
    def verdict(self) -> Verdict:
        outcomes = [stage.result for stage in self.stages] + [expectation.result for expectation in self.expectations]
        outcomes += [phase.result for phase in self.phases]
        outcomes += [measurement.result for measurement in self.measurements]
        if "fail" in outcomes:
            return "fail"
        if "not reached" in outcomes or "not run" in outcomes or "inconclusive" in outcomes:
            return "incomplete"
        return "pass"

    def to_dict(self) -> dict:
        return {"verdict": self.verdict, **asdict(self),
                "measurements": [measurement.to_dict() for measurement in self.measurements]}

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), indent=2, sort_keys=False)

    def summary(self) -> str:
        lines = [f"run {self.run_id} mode={self.mode} verdict={self.verdict}"]
        if self.fixtures.get("error"):
            lines.append(f"  fixtures failed: {self.fixtures['error']}")
        for stage in self.stages:
            lines.append(f"  {stage.result:<12} {stage.stage}" + (f" ({stage.reason})" if stage.reason else ""))
        for phase in self.phases:
            lines.append(f"  {phase.result:<16} {phase.phase} {phase_line(phase)}" + (f" ({phase.reason})" if phase.reason else ""))
        for measurement in self.measurements:
            lines.append(f"  {measurement.result:<16} {measurement.line()}")
        for expectation in self.expectations:
            ids = ",".join(expectation.requirements)
            note = expectation.reason or (f"known issue {expectation.known_issue}" if expectation.known_issue else "")
            lines.append(
                f"  {expectation.result:<16} {expectation.scenario}: {expectation.expectation} [{ids}]"
                + (f" ({note})" if note else "")
            )
        if self.storage:
            lines.append(f"  report: {self.storage.get('uri')} stored={self.storage.get('stored')}")
        return "\n".join(lines)


def phase_line(phase: PhaseResult) -> str:
    if "backlog" in phase.target:
        drain = phase.metrics.get("drain_rate")
        return f"backlog {phase.target['backlog']} records" + (f": drained at {drain} records/s" if drain else "")
    line = f"{phase.target['eps']:g} eps x {phase.target['duration_s']:g} s"
    metrics = phase.metrics
    if not metrics or not metrics["events_sent"]:
        return line
    lag = ", ".join(f"{topic} {values['max']}" for topic, values in metrics["lag"].items())
    return (
        f"{line}: sent {metrics['events_sent']} at {metrics['achieved_eps']} eps ({metrics['achieved_share']:.1%} of"
        f" target), errors {metrics['send_error_rate']:.2%}, latency to parsed p95"
        f" {metrics['latency_to_parsed_ms'].get('p95')} ms, max lag [{lag}], sender {metrics['sender']['cpu_cores']} cores"
    )


def report_key(run_id: str) -> str:
    return f"sim-reports/{run_id}.json"


def store(report: Report, bucket: str | None) -> dict:
    """Puts the report at s3://<bucket>/sim-reports/<run id>.json with the pod's node role. Never raises."""
    if not bucket:
        return {"uri": None, "stored": False, "error": "SIM_REPORT_BUCKET is not set"}
    uri = f"s3://{bucket}/{report_key(report.run_id)}"
    try:
        import boto3

        boto3.client("s3").put_object(
            Bucket=bucket, Key=report_key(report.run_id), Body=report.to_json().encode(), ContentType="application/json"
        )
    except Exception as error:  # noqa: BLE001  The report must still reach the log when storage fails.
        return {"uri": uri, "stored": False, "error": f"{type(error).__name__}: {error}"}
    return {"uri": uri, "stored": True, "error": None}
