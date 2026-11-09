import json
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

import pytest

from cdp_sim.gauges import prometheus_value
from cdp_sim.settings import DATA_NODE_FILESYSTEM, PROMETHEUS_URL

# The series the aws-free-plan cluster reports, in the shapes seen there on 2026-11-08. node-exporter runs with
# hostNetwork, so its instance is the node's IP and port, and its nodename is the EC2 hostname, never the k3s name.
NODES = {"platform-1": ("172.31.12.131", 0.412), "data-1": ("172.31.14.237", 0.194),
         "compute-1": ("172.31.9.18", 0.377)}
FILESYSTEM_USE = {f"{ip}:9100": use for ip, use in NODES.values()}
NODE_UNAME_INFO = [
    {"__name__": "node_uname_info", "container": "node-exporter", "endpoint": "http-metrics",
     "instance": f"{ip}:9100", "job": "node-exporter", "machine": "x86_64", "namespace": "monitoring",
     "nodename": f"ip-{ip.replace('.', '-')}.ec2.internal", "pod": "kps-prometheus-node-exporter-7xk2q",
     "service": "kps-prometheus-node-exporter", "sysname": "Linux"}
    for ip, _ in NODES.values()
]
KUBE_NODE_INFO = [
    {"__name__": "kube_node_info", "container": "kube-state-metrics", "endpoint": "http",
     "instance": "10.42.1.7:8080", "internal_ip": ip, "job": "kube-state-metrics", "namespace": "monitoring",
     "node": node, "os_image": "Amazon Linux 2023", "provider_id": f"k3s://{node}",
     "service": "kps-kube-state-metrics"}
    for node, (ip, _) in NODES.items()
]
SERIES = {"node_uname_info": NODE_UNAME_INFO, "kube_node_info": KUBE_NODE_INFO}

FILESYSTEM = '(1 - node_filesystem_avail_bytes{mountpoint="/"} / node_filesystem_size_bytes{mountpoint="/"})'
JOIN = re.compile(r"\* on\(instance\) group_left\((\w*)\) (.+)")
SELECTOR = re.compile(r'(\w+)\{(\w+)="([^"]*)"\}')
LABEL_REPLACE = re.compile(r'label_replace\((.+), "(\w+)", "\$1:9100", "(\w+)", "\(\.\*\)"\)')


def evaluate(query: str) -> list[dict]:
    """The filesystem use joined on instance to one node's info series, the one query shape the gauge sends."""
    query = " ".join(query.split())
    assert query.startswith(FILESYSTEM), query
    join = JOIN.fullmatch(query[len(FILESYSTEM):].strip())
    assert join, query
    copied, right = join.groups()
    relabel = LABEL_REPLACE.fullmatch(right)
    selector = SELECTOR.fullmatch(relabel.group(1) if relabel else right)
    assert selector, right
    name, label, value = selector.groups()
    infos = [series for series in SERIES[name] if series.get(label) == value]
    if relabel:
        target, source = relabel.group(2), relabel.group(3)
        infos = [info | {target: f"{info[source]}:9100"} for info in infos]
    return [
        {"metric": {"instance": info["instance"], "mountpoint": "/"} | ({copied: info[copied]} if copied else {}),
         "value": [1762560000.123, str(FILESYSTEM_USE[info["instance"]])]}
        for info in infos if info["instance"] in FILESYSTEM_USE
    ]


@pytest.fixture
def prometheus():
    seen = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            query = parse_qs(urlsplit(self.path).query)["query"][0]
            seen.append(query)
            body = {"status": "success", "data": {"resultType": "vector", "result": evaluate(query)}}
            payload = json.dumps(body).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", seen
    finally:
        server.shutdown()


def test_the_volume_query_reads_data_1s_root_filesystem_and_no_other_node(prometheus):
    url, seen = prometheus
    assert prometheus_value(url, DATA_NODE_FILESYSTEM) == 0.194
    assert seen == [DATA_NODE_FILESYSTEM]


def test_a_query_that_picks_data_1_by_its_hostname_finds_nothing_on_this_cluster(prometheus):
    url, _ = prometheus
    by_hostname = f'{FILESYSTEM} * on(instance) group_left(nodename) node_uname_info{{nodename="data-1"}}'
    with pytest.raises(RuntimeError, match="no series"):
        prometheus_value(url, by_hostname)


def test_the_volume_gauge_asks_the_clusters_prometheus_service():
    assert PROMETHEUS_URL == "http://kps-kube-prometheus-stack-prometheus.monitoring.svc:9090"
