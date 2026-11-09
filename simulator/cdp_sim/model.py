"""The scenario model that every mode shares (SIM-FR-01): products, events, personas, and the funnel."""

from __future__ import annotations

import hashlib
import random
import secrets
import time
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum


class Step(Enum):
    """A funnel step. Its value is the `sim_` event name the step sends (SIM-FR-02)."""

    VIEW_PAGE = "sim_view_page"
    SEARCH = "sim_search"
    VIEW_PRODUCT = "sim_view_product"
    ADD_TO_CART = "sim_add_to_cart"
    LOGIN = "sim_login"
    BEGIN_CHECKOUT = "sim_begin_checkout"
    PURCHASE = "sim_purchase"


FUNNEL: tuple[Step, ...] = (
    Step.VIEW_PAGE,
    Step.SEARCH,
    Step.VIEW_PRODUCT,
    Step.ADD_TO_CART,
    Step.LOGIN,
    Step.BEGIN_CHECKOUT,
    Step.PURCHASE,
)


@dataclass(frozen=True)
class Product:
    sku: str
    name: str
    category: str
    price: int


def _catalog() -> tuple[Product, ...]:
    categories = ("phones", "laptops", "audio", "home", "fashion")
    return tuple(
        Product(
            sku=f"SIM-SKU-{n:03d}",
            name=f"Sim product {n:03d}",
            category=categories[n % len(categories)],
            price=99_000 + 250_000 * (n % 17),
        )
        for n in range(1, 41)
    )


PRODUCTS: tuple[Product, ...] = _catalog()
# Long-tail popularity: the product at rank r is picked with weight 1/r, so a few products get most views.
POPULARITY: tuple[float, ...] = tuple(1 / rank for rank in range(1, len(PRODUCTS) + 1))


@dataclass(frozen=True)
class Persona:
    """A kind of shopper. `goal` is the furthest funnel step it reaches. LOGIN is taken only by `logs_in` personas."""

    name: str
    share: float
    goal: Step
    logs_in: bool
    sessions: int = 1
    search_chance: float = 0.5
    repeat_view_chance: float = 0.4


PERSONAS: tuple[Persona, ...] = (
    Persona("browser", 0.60, Step.VIEW_PRODUCT, logs_in=False),
    Persona("hesitant", 0.25, Step.ADD_TO_CART, logs_in=False),
    Persona("buyer", 0.12, Step.PURCHASE, logs_in=True),
    Persona("returning_buyer", 0.03, Step.PURCHASE, logs_in=True, sessions=2),
)
PERSONA_BY_NAME: Mapping[str, Persona] = {persona.name: persona for persona in PERSONAS}


def new_run_id(now: datetime | None = None) -> str:
    stamp = (now or datetime.now(timezone.utc)).strftime("%Y%m%dt%H%M%S")
    return f"{stamp}-{secrets.token_hex(3)}"


@dataclass(frozen=True)
class Shopper:
    """One simulated person in a run. Both ids embed the run id, so they are unique to the run (SIM-FR-03)."""

    run_id: str
    index: int
    persona: Persona

    @property
    def device_id(self) -> str:
        return f"sim-{self.run_id}-d{self.index}"

    @property
    def user_id(self) -> str:
        return f"sim-{self.run_id}-u{self.index}"


@dataclass(frozen=True)
class TrackedEvent:
    """One event as a tracker sends it. `event_id` is None only when a scenario sends an invalid event on purpose.

    A self-describing event has a `sim_` `name` and `attributes` as its data. A structured event has no name of its
    own: ingestion names it by `se_ac`, and `attributes` holds its `se_*` fields.
    """

    run_id: str
    device_id: str
    user_id: str | None
    event_id: str | None
    timestamp_ms: int
    name: str | None
    attributes: Mapping[str, object] = field(default_factory=dict)
    structured: bool = False


def now_ms() -> int:
    return time.time_ns() // 1_000_000


def derived_root(prefix: str, value: str) -> str:
    """A root as identity stitching derives it: the name-based UUID (version 3) of prefix + value."""
    return str(uuid.UUID(bytes=hashlib.md5((prefix + value).encode()).digest(), version=3))


def device_root(device_id: str) -> str:
    """The canon_id of a device's events before any login."""
    return derived_root("canon-domain_userid:", device_id)


def user_root(user_id: str) -> str:
    """The canon_id of a user's events from the login on."""
    return derived_root("canon:", user_id)


def named(shopper: Shopper, name: str, attributes: Mapping[str, object], logged_in: bool = False) -> TrackedEvent:
    return TrackedEvent(
        run_id=shopper.run_id,
        device_id=shopper.device_id,
        user_id=shopper.user_id if logged_in else None,
        event_id=str(uuid.uuid4()),
        timestamp_ms=now_ms(),
        name=name,
        attributes=attributes,
    )


def track(shopper: Shopper, step: Step, attributes: Mapping[str, object], logged_in: bool) -> TrackedEvent:
    return named(shopper, step.value, attributes, logged_in)


def step_attributes(step: Step, product: Product, query: str = "") -> dict[str, object]:
    item = {"sku": product.sku, "name": product.name, "category": product.category, "price": product.price}
    match step:
        case Step.VIEW_PAGE:
            return {"page": {"path": "/"}}
        case Step.SEARCH:
            return {"search": {"query": query or product.category}}
        case Step.VIEW_PRODUCT | Step.ADD_TO_CART:
            return {"product": item}
        case Step.LOGIN:
            return {"method": "password"}
        case Step.BEGIN_CHECKOUT:
            return {"cart": {"items": [item], "total": product.price}}
        case Step.PURCHASE:
            return {"order": {"id": f"SIM-ORD-{uuid.uuid4().hex[:10]}", "items": [item], "total": product.price}}


def script(shopper: Shopper, steps: Sequence[Step], product: Product = PRODUCTS[0]) -> list[TrackedEvent]:
    """A scripted visit for smoke and logical runs, whose outcome is known in advance."""
    events, logged_in = [], False
    for step in steps:
        logged_in = logged_in or step is Step.LOGIN
        events.append(track(shopper, step, step_attributes(step, product), logged_in))
    return events


def browse(shopper: Shopper, rng: random.Random) -> list[TrackedEvent]:
    """A random visit drawn from the persona, for load runs. A logged-in persona sends its user id from login onward."""
    persona = shopper.persona
    events: list[TrackedEvent] = []
    logged_in = False
    for _ in range(persona.sessions):
        product = rng.choices(PRODUCTS, weights=POPULARITY)[0]
        for step in FUNNEL[: FUNNEL.index(persona.goal) + 1]:
            if step is Step.LOGIN and (not persona.logs_in or logged_in):
                continue
            if step is Step.SEARCH and rng.random() >= persona.search_chance:
                continue
            logged_in = logged_in or step is Step.LOGIN
            events.append(track(shopper, step, step_attributes(step, product), logged_in))
            while step is Step.VIEW_PRODUCT and rng.random() < persona.repeat_view_chance:
                product = rng.choices(PRODUCTS, weights=POPULARITY)[0]
                events.append(track(shopper, step, step_attributes(step, product), logged_in))
    return events


def pick_persona(rng: random.Random) -> Persona:
    return rng.choices(PERSONAS, weights=[persona.share for persona in PERSONAS])[0]
