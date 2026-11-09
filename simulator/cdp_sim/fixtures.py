"""The test fixtures a run needs, made through studio's own interfaces (SIM-FR-17), and made only once (SIM-FR-05).

Fixtures are the `sim_` catalog events, one with its schema gate on, and the `sim_` abandoned-cart campaign. Publishing
the campaign creates the metric definition that `customer-profile-mutations` needs (CMP-FR-01): its setup node holds
the behavior condition "sim_add_to_cart COUNT >= 1 in 1 day", which every shopper who adds to the cart passes, because
customer decision counts an event before it evaluates conditions on it.

Prepare is idempotent because it is a plan against what Postgres already holds, read in a read-only session: it calls
an action only for a fixture that is missing or differs. No studio action lists campaigns, and publish is not a no-op
(it writes a new graph version), so a campaign carries a fingerprint of its journey in its description, and a campaign
whose stored row is active with that fingerprint is left alone.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable
from dataclasses import dataclass, field

from cdp_sim.db import Database
from cdp_sim.model import Step
from cdp_sim.studio import Studio, StudioError

DESCRIPTION = "Traffic simulator fixture. Do not edit: the simulator recreates it."
CREATE_EVENT = "createUserEventWithFieldsAction"
ADD_ATTRIBUTE = "createUserEventFieldAction"
SET_REQUIRED = "setUserEventFieldRequiredAction"
SET_GATE = "setUserEventSchemaEnforcementAction"
PUBLISH = "publishCampaignAction"
DELETE_CAMPAIGN = "deleteCampaignAction"
DELETE_EVENT = "deleteUserEventAction"
PREPARE_ACTIONS = {CREATE_EVENT, ADD_ATTRIBUTE, SET_REQUIRED, SET_GATE, PUBLISH}
CLEANUP_ACTIONS = {DELETE_CAMPAIGN, DELETE_EVENT}

GATED_EVENT = "sim_gated_check"
GATED_ATTRIBUTE = "sku"
STRUCT_EVENT = "sim_struct_check"
# The node ids of the abandoned-cart journey, which the checks read back from topics and transitions.
SETUP_NODE, WATCH_NODE, NOTIFY_NODE = "sim_cart_added", "sim_purchase_watch", "sim_cart_reminder"
METRIC_EVENT = Step.ADD_TO_CART.value


class FixtureError(Exception):
    """A fixture could not be made. The run stops before it sends anything and reports this message."""


@dataclass(frozen=True)
class Attribute:
    path: str
    type: str
    required: bool = False


@dataclass(frozen=True)
class CatalogEvent:
    name: str
    attributes: tuple[Attribute, ...]
    gated: bool = False


RUN_ID = Attribute("run_id", "string")
PRODUCT = (Attribute("product", "json"), Attribute("product.sku", "string"), Attribute("product.price", "number"))
CATALOG: tuple[CatalogEvent, ...] = (
    CatalogEvent(Step.VIEW_PAGE.value, (RUN_ID, Attribute("page", "json"))),
    CatalogEvent(Step.SEARCH.value, (RUN_ID, Attribute("search", "json"))),
    CatalogEvent(Step.VIEW_PRODUCT.value, (RUN_ID, *PRODUCT)),
    CatalogEvent(Step.ADD_TO_CART.value, (RUN_ID, *PRODUCT)),
    CatalogEvent(Step.LOGIN.value, (RUN_ID, Attribute("method", "string"))),
    CatalogEvent(Step.BEGIN_CHECKOUT.value, (RUN_ID, Attribute("cart", "json"))),
    CatalogEvent(Step.PURCHASE.value, (RUN_ID, Attribute("order", "json"))),
    CatalogEvent(STRUCT_EVENT, tuple(Attribute(key, "string") for key in ("category", "action", "label"))
                 + (Attribute("value", "number"),)),
    CatalogEvent(GATED_EVENT, (RUN_ID, Attribute(GATED_ATTRIBUTE, "string", required=True)), gated=True),
)


def campaign_id(window_s: int) -> str:
    """One campaign per window, so runs with different windows never republish each other's journey."""
    return f"sim_abandoned_cart_{window_s}s"


def abandoned_cart(window_s: int) -> dict:
    """The publish payload: add to cart, then a purchase within the window ends the journey, and a timeout sends one
    webhook request to a non-routable address."""
    def end(node_id: str) -> dict:
        return {"type": "end", "id": node_id}

    root = {
        "type": "setup",
        "id": SETUP_NODE,
        "label": "Added to cart",
        "description": "Traffic simulator: a shopper adds a product to the cart.",
        "triggerType": "user",
        "triggerEventName": Step.ADD_TO_CART.value,
        "conditions": {"groups": [{"conditions": [{
            "type": "behavior", "event": METRIC_EVENT, "measure": "COUNT",
            "window": {"value": 1, "unit": "DAYS"}, "op": ">=", "value": 1,
        }]}]},
        "next": {
            "type": "watch",
            "id": WATCH_NODE,
            "label": "Purchase within the window",
            "eventName": Step.PURCHASE.value,
            "timeLimitValue": window_s,
            "timeLimitUnit": "seconds",
            "next": {
                "type": "SuccessOrTimeoutPath",
                "success": end("sim_cart_purchased"),
                "timeout": {
                    "type": "engagement",
                    "id": NOTIFY_NODE,
                    "label": "Cart reminder",
                    "action": {"type": "webhook", "url": "https://sim.invalid/abandoned-cart", "method": "POST",
                               "payload": {"sim": True}},
                    "next": end("sim_cart_reminded"),
                },
            },
        },
    }
    name = campaign_id(window_s)
    fingerprint = hashlib.sha256(json.dumps({"name": name, "root": root}, sort_keys=True).encode()).hexdigest()[:16]
    return {"id": name, "name": name, "description": f"{DESCRIPTION} Fingerprint {fingerprint}.", "root": root}


@dataclass(frozen=True)
class StoredEvent:
    id: str
    gated: bool
    attributes: dict[str, tuple[str, bool]]


@dataclass(frozen=True)
class StoredCampaign:
    status: str
    description: str | None


@dataclass(frozen=True)
class Stored:
    events: dict[str, StoredEvent]
    campaigns: dict[str, StoredCampaign]


def read_stored(db: Database) -> Stored:
    events: dict[str, StoredEvent] = {}
    for row in db.rows(
        "SELECT e.id, e.event_name, e.enforce_schema, f.field_path, f.data_type, f.required"
        " FROM user_events e LEFT JOIN user_event_fields f ON f.user_event_id = e.id"
        " WHERE e.event_name LIKE 'sim\\_%'"
    ):
        event = events.setdefault(row["event_name"], StoredEvent(row["id"], bool(row["enforce_schema"]), {}))
        if row["field_path"] is not None:
            event.attributes[row["field_path"]] = (str(row["data_type"]).lower(), bool(row["required"]))
    campaigns = {
        row["id"]: StoredCampaign(row["status"], row["description"])
        for row in db.rows("SELECT id, status, description FROM campaigns WHERE id LIKE 'sim\\_%'")
    }
    return Stored(events, campaigns)


@dataclass(frozen=True)
class EventRef:
    """An event's id, known only once the event exists. Resolved when the write runs."""

    name: str


@dataclass(frozen=True)
class Write:
    fixture: str
    action: str
    args: tuple


def plan(catalog: tuple[CatalogEvent, ...], campaigns: list[dict], stored: Stored) -> list[Write]:
    """The writes that make the stored fixtures match the wanted ones. Empty when they already match (SIM-FR-05)."""
    writes: list[Write] = []
    for event in catalog:
        label, ref = f"catalog event {event.name}", EventRef(event.name)
        current = stored.events.get(event.name)
        if current is None:
            fields = [{"fieldPath": a.path, "displayName": a.path, "dataType": a.type} for a in event.attributes]
            display = event.name.replace("_", " ").capitalize()
            writes.append(Write(label, CREATE_EVENT, (event.name, display, DESCRIPTION, {"kind": "person"}, fields)))
        have = current.attributes if current else {}
        for attribute in event.attributes:
            if current and attribute.path not in have:
                writes.append(Write(label, ADD_ATTRIBUTE, (ref, attribute.path, attribute.path, attribute.type)))
            elif current and have[attribute.path][0] != attribute.type:
                raise FixtureError(
                    f"{label}: attribute {attribute.path} is {have[attribute.path][0]} in the catalog, not {attribute.type}"
                )
            if have.get(attribute.path, ("", False))[1] != attribute.required:
                writes.append(Write(label, SET_REQUIRED, (ref, attribute.path, attribute.required)))
        if (current.gated if current else False) != event.gated:
            writes.append(Write(label, SET_GATE, (ref, event.gated)))
    for campaign in campaigns:
        current_campaign = stored.campaigns.get(campaign["id"])
        if current_campaign != StoredCampaign("active", campaign["description"]):
            writes.append(Write(f"campaign {campaign['id']}", PUBLISH, (campaign,)))
    return writes


def apply(studio: Studio, writes: list[Write], stored: Stored) -> None:
    ids = {name: event.id for name, event in stored.events.items()}
    for write in writes:
        args = tuple(ids[arg.name] if isinstance(arg, EventRef) else arg for arg in write.args)
        try:
            result = studio.call(write.action, *args)
        except StudioError as error:
            raise FixtureError(f"{write.fixture}: {error}") from None
        if write.action == CREATE_EVENT:
            ids[args[0]] = result["eventId"]


@dataclass(frozen=True)
class Fixtures:
    campaign_id: str
    metric_definition_id: str
    gated_event: str
    window_s: int
    writes: tuple[str, ...] = field(default_factory=tuple)

    @property
    def published(self) -> bool:
        return any(write.startswith("campaign ") for write in self.writes)

    @property
    def gate_changed(self) -> bool:
        return any(write == f"catalog event {GATED_EVENT}: {SET_GATE}" for write in self.writes)


def prepare(db: Database, window_s: int, open_studio: Callable[[set[str]], Studio]) -> Fixtures:
    """Makes every fixture exist, then checks that a second plan is empty and the metric definition is LIVE.

    `open_studio` signs in and discovers the actions it is given. Prepare calls it only when a write is needed, so a
    run whose fixtures already match never signs in. Raises FixtureError naming the fixture and why.
    """
    campaigns = [abandoned_cart(window_s)]
    stored = read_stored(db)
    writes = plan(CATALOG, campaigns, stored)
    if writes:
        try:
            studio = open_studio(PREPARE_ACTIONS)
        except StudioError as error:
            raise FixtureError(f"{writes[0].fixture}: {error}") from None
        apply(studio, writes, stored)
        if leftover := plan(CATALOG, campaigns, read_stored(db)):
            raise FixtureError(f"{leftover[0].fixture}: still differs after prepare ({leftover[0].action})")
    live = db.rows(
        "SELECT id FROM user_metric_definitions WHERE event_name = :name AND processing_mode = 'LIVE' ORDER BY id",
        name=METRIC_EVENT,
    )
    if not live:
        raise FixtureError(f"metric definition: no LIVE definition counts {METRIC_EVENT} after publishing {campaign_id(window_s)}")
    return Fixtures(
        campaign_id=campaign_id(window_s),
        metric_definition_id=live[0]["id"],
        gated_event=GATED_EVENT,
        window_s=window_s,
        writes=tuple(f"{write.fixture}: {write.action}" for write in writes),
    )
