"""Run settings, read once from the environment at start. Postgres reads its own PG* variables (db.py)."""

from __future__ import annotations

import os
from dataclasses import dataclass

PROMETHEUS_URL = "http://kps-kube-prometheus-stack-prometheus.monitoring.svc:9090"
# The share of the data node's root filesystem in use. Kafka's and Postgres's local-path volumes live on it.
# node-exporter's instance label is the node's IP and port, and its nodename is the EC2 hostname, not the k3s node
# name. kube-state-metrics' kube_node_info carries both the k3s name and the internal IP, so it picks the node.
DATA_NODE_FILESYSTEM = (
    '(1 - node_filesystem_avail_bytes{mountpoint="/"} / node_filesystem_size_bytes{mountpoint="/"})'
    ' * on(instance) group_left()'
    ' label_replace(kube_node_info{node="data-1"}, "instance", "$1:9100", "internal_ip", "(.*)")'
)
# The size of the Postgres claim, 8 GiB, which Postgres's own bytes are measured against.
PG_VOLUME_BYTES = 8 * 1024**3


@dataclass(frozen=True)
class Settings:
    collector_url: str
    kafka_brokers: str
    report_bucket: str | None
    studio_url: str | None
    login_secret_id: str
    login_secret_entry: str
    stage_timeout_s: float
    # The watch window of the sim_ abandoned-cart campaign, in whole seconds (SIM-FR-18).
    scenario_window_s: int
    # A load run's stop conditions read the data node's filesystem from Prometheus, and Postgres's own size (SIM-FR-12).
    prometheus_url: str = PROMETHEUS_URL
    volume_query: str = DATA_NODE_FILESYSTEM
    pg_volume_bytes: int = PG_VOLUME_BYTES

    @classmethod
    def from_environment(cls) -> Settings:
        env = os.environ
        settings = cls(
            collector_url=env.get("SIM_COLLECTOR_URL", "http://collector.cdp.svc"),
            kafka_brokers=env.get("SIM_KAFKA_BROKERS", "cdp-kafka-bootstrap.cdp.svc:9092"),
            report_bucket=env.get("SIM_REPORT_BUCKET") or None,
            studio_url=env.get("SIM_STUDIO_URL") or None,
            login_secret_id=env.get("SIM_LOGIN_SECRET_ID", "cdp-free-plan/logins"),
            login_secret_entry=env.get("SIM_LOGIN_SECRET_ENTRY", "sim_bot"),
            stage_timeout_s=float(env.get("SIM_STAGE_TIMEOUT_S", "45")),
            scenario_window_s=int(env.get("SIM_SCENARIO_WINDOW_S", "60")),
            prometheus_url=env.get("SIM_PROMETHEUS_URL", PROMETHEUS_URL),
            volume_query=env.get("SIM_VOLUME_QUERY", DATA_NODE_FILESYSTEM),
            pg_volume_bytes=int(env.get("SIM_PG_VOLUME_BYTES", PG_VOLUME_BYTES)),
        )
        if settings.stage_timeout_s <= 0 or settings.scenario_window_s <= 0 or settings.pg_volume_bytes <= 0:
            raise ValueError("SIM_STAGE_TIMEOUT_S, SIM_SCENARIO_WINDOW_S, and SIM_PG_VOLUME_BYTES must be positive")
        return settings
