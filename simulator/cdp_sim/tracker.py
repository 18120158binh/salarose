"""The Snowplow tracker protocol: POST batches to tp2 and GET pixels to /i (SIM-FR-04)."""

from __future__ import annotations

import base64
import json
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Sequence
from dataclasses import dataclass

from cdp_sim.model import TrackedEvent

POST_PATH = "/com.snowplowanalytics.snowplow/tp2"
GET_PATH = "/i"
PAYLOAD_SCHEMA = "iglu:com.snowplowanalytics.snowplow/payload_data/jsonschema/1-0-4"
UNSTRUCT_SCHEMA = "iglu:com.snowplowanalytics.snowplow/unstruct_event/jsonschema/1-0-0"
CONTEXTS_SCHEMA = "iglu:com.snowplowanalytics.snowplow/contexts/jsonschema/1-0-1"
RUN_ENTITY_SCHEMA = "iglu:io.cdp.sim/run/jsonschema/1-0-0"
# Ingestion files the run entity under this key of event_json (ING-FR-18).
RUN_ENTITY_KEY = "io.cdp.sim/run"
APP_ID = "cdp-sim"
TRACKER_VERSION = "cdp-sim-0.1"


def event_schema(name: str) -> str:
    return f"iglu:io.cdp.sim/{name}/jsonschema/1-0-0"


def tracker_params(event: TrackedEvent) -> dict[str, str]:
    """The tracker fields of one event, with JSON fields as plain JSON, as a POST body carries them."""
    stamp = str(event.timestamp_ms)
    params = {
        "e": "se" if event.structured else "ue",
        "p": "web",
        "tv": TRACKER_VERSION,
        "aid": APP_ID,
        "duid": event.device_id,
        "dtm": stamp,
        "stm": stamp,
        "ttm": stamp,
        "co": json.dumps({"schema": CONTEXTS_SCHEMA, "data": [{"schema": RUN_ENTITY_SCHEMA, "data": {"run_id": event.run_id}}]}),
    }
    if event.event_id is not None:
        params["eid"] = event.event_id
    if event.user_id is not None:
        params["uid"] = event.user_id
    if event.structured:
        params.update({key: str(value) for key, value in event.attributes.items()})
    else:
        data = {"event_name": event.name, "run_id": event.run_id, **event.attributes}
        params["ue_pr"] = json.dumps({"schema": UNSTRUCT_SCHEMA, "data": {"schema": event_schema(event.name), "data": data}})
    return params


def post_body(events: Sequence[TrackedEvent]) -> bytes:
    return json.dumps({"schema": PAYLOAD_SCHEMA, "data": [tracker_params(event) for event in events]}).encode()


def pixel_query(event: TrackedEvent) -> str:
    """The query string of a GET pixel. A pixel carries its JSON fields in URL-safe Base64, as `ue_px` and `cx`."""
    params = tracker_params(event)
    for plain, encoded in (("ue_pr", "ue_px"), ("co", "cx")):
        if plain in params:
            params[encoded] = base64.urlsafe_b64encode(params.pop(plain).encode()).decode()
    return urllib.parse.urlencode(params)


@dataclass(frozen=True)
class HitResult:
    method: str
    event_ids: tuple[str | None, ...]
    status: int | None
    error: str | None = None

    @property
    def ok(self) -> bool:
        return self.status == 200


class Collector:
    """Sends tracker hits to one collector, such as the in-cluster Service `http://collector.cdp.svc`."""

    def __init__(self, base_url: str, timeout_s: float = 10.0) -> None:
        self._base_url = base_url.rstrip("/")
        self._timeout_s = timeout_s

    def post(self, events: Sequence[TrackedEvent]) -> HitResult:
        request = urllib.request.Request(
            self._base_url + POST_PATH,
            data=post_body(events),
            headers={"Content-Type": "application/json; charset=UTF-8"},
            method="POST",
        )
        return self._send(request, "POST", tuple(event.event_id for event in events))

    def pixel(self, event: TrackedEvent) -> HitResult:
        request = urllib.request.Request(f"{self._base_url}{GET_PATH}?{pixel_query(event)}", method="GET")
        return self._send(request, "GET", (event.event_id,))

    def _send(self, request: urllib.request.Request, method: str, event_ids: tuple[str | None, ...]) -> HitResult:
        try:
            with urllib.request.urlopen(request, timeout=self._timeout_s) as response:
                return HitResult(method, event_ids, response.status)
        except urllib.error.HTTPError as error:
            return HitResult(method, event_ids, error.code, f"HTTP {error.code}")
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            return HitResult(method, event_ids, None, f"{type(error).__name__}: {error}")
