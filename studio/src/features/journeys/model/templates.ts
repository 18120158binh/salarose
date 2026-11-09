// The built-in journey templates (JBD-FR-30). Each names its events by their catalog system names,
// so a shop whose catalog holds them gets every mapping prefilled. Message copy is Vietnamese, and
// every message is a push or an SMS.

export type TemplateKey = "welcome" | "cart" | "browse" | "winback" | "post";

/** An event a template needs: its catalog system name and the label the gallery shows. */
export interface TemplateEvent {
  readonly name: string;
  readonly label: string;
}

/** One box of the card's small graph: the step's text and its kind, which picks its tint. */
export interface PreviewCell {
  readonly text: string;
  readonly kind: "start" | "wait" | "message" | "end" | "blank";
}

export interface JourneyTemplate {
  readonly key: TemplateKey;
  readonly name: string;
  readonly purpose: string;
  readonly needs: readonly TemplateEvent[];
  readonly channels: string;
  /** The card's graph, top to bottom; a row with two cells is a split into Success and Timeout. */
  readonly preview: readonly (readonly PreviewCell[])[];
  readonly root: Record<string, unknown>;
}

const SIGNED_UP: TemplateEvent = { name: "com.acme/account_signed_up", label: "Account signed up" };
const ADDED_TO_CART: TemplateEvent = { name: "com.acme/add_to_cart", label: "Added to cart" };
const ORDER_COMPLETED: TemplateEvent = { name: "com.acme/order_completed", label: "Order completed" };
const PRODUCT_VIEWED: TemplateEvent = { name: "com.acme/product_viewed", label: "Product viewed" };

const END = { type: "end" };

function start(id: string, event: TemplateEvent, next: unknown, conditions?: unknown): Record<string, unknown> {
  return { type: "setup", id, label: "Start", description: "", triggerType: "user", triggerEventName: event.name, ...(conditions ? { conditions } : {}), next };
}

function push(id: string, title: string, body: string, next: unknown = END) {
  return { type: "engagement", id, label: "Push", action: { type: "push", title, body }, next };
}

function sms(id: string, body: string, next: unknown = END) {
  return { type: "engagement", id, label: "SMS", action: { type: "sms", body }, next };
}

function waitFor(id: string, event: TemplateEvent, value: number, unit: "hours" | "days", success: unknown, timeout: unknown) {
  return {
    type: "watch",
    id,
    label: "Wait",
    eventName: event.name,
    timeLimitValue: value,
    timeLimitUnit: unit,
    next: { type: "SuccessOrTimeoutPath", success, timeout },
  };
}

function delay(id: string, value: number, unit: "hours" | "days", next: unknown) {
  return { type: "watch", id, label: "Wait", timeLimitValue: value, timeLimitUnit: unit, next: { type: "DelayPath", next } };
}

const cell = (text: string, kind: PreviewCell["kind"]): PreviewCell => ({ text, kind });

export const TEMPLATES: readonly JourneyTemplate[] = [
  {
    key: "welcome",
    name: "Welcome series",
    purpose: "Greet new sign-ups with a push, and nudge a first order after 3 days.",
    needs: [SIGNED_UP, ORDER_COMPLETED],
    channels: "Push, SMS",
    preview: [
      [cell("Start: Account signed up", "start")],
      [cell("Push “Chào mừng bạn”", "message")],
      [cell("Wait for Order completed, 3 days", "wait")],
      [cell("Success: End", "end"), cell("Timeout: SMS “Quà 10%”", "message")],
    ],
    root: start(
      "start",
      SIGNED_UP,
      push(
        "welcome_push",
        "Chào mừng bạn đến Mộc Lan",
        "Cảm ơn bạn đã đăng ký. Khám phá bộ sưu tập mới nhé!",
        waitFor("first_order", ORDER_COMPLETED, 3, "days", END, sms("gift_sms", "Mộc Lan tặng bạn mã giảm 10% cho đơn đầu tiên: CHAOBAN10.")),
      ),
    ),
  },
  {
    key: "cart",
    name: "Abandoned cart",
    purpose: "Remind people who add to cart but don’t order within 2 hours.",
    needs: [ADDED_TO_CART, ORDER_COMPLETED],
    channels: "Push, SMS",
    preview: [
      [cell("Start: Added to cart", "start")],
      [cell("Wait for Order completed, 2 hours", "wait")],
      [cell("Success: End", "end"), cell("Timeout: Push “Bạn quên giỏ hàng?”", "message")],
      [cell("", "blank"), cell("Wait 1 day, then SMS", "message")],
    ],
    root: start(
      "start",
      ADDED_TO_CART,
      waitFor(
        "wait_order",
        ORDER_COMPLETED,
        2,
        "hours",
        END,
        push(
          "cart_push",
          "Bạn quên giỏ hàng?",
          "Sản phẩm bạn chọn vẫn đang chờ. Hoàn tất đơn hàng ngay nhé.",
          delay("wait_day", 1, "days", sms("cart_sms", "Giỏ hàng của bạn tại Mộc Lan vẫn còn. Đặt ngay trước khi hết hàng.")),
        ),
      ),
    ),
  },
  {
    key: "browse",
    name: "Browse abandonment",
    purpose: "Follow up when someone views a product but doesn’t add it to cart within a day.",
    needs: [PRODUCT_VIEWED, ADDED_TO_CART],
    channels: "Push",
    preview: [
      [cell("Start: Product viewed", "start")],
      [cell("Wait for Added to cart, 1 day", "wait")],
      [cell("Success: End", "end"), cell("Timeout: Push “Vẫn còn hàng”", "message")],
    ],
    root: start(
      "start",
      PRODUCT_VIEWED,
      waitFor("wait_cart", ADDED_TO_CART, 1, "days", END, push("browse_push", "Vẫn còn hàng", "Sản phẩm bạn vừa xem vẫn còn. Ghé Mộc Lan xem lại nhé.")),
    ),
  },
  {
    key: "winback",
    name: "Win-back",
    purpose: "When a past buyer comes back to browse, offer a voucher if they don’t order within a day.",
    needs: [PRODUCT_VIEWED, ORDER_COMPLETED],
    channels: "Push, SMS",
    preview: [
      [cell("Start: Product viewed, bought before", "start")],
      [cell("Wait for Order completed, 1 day", "wait")],
      [cell("Success: End", "end"), cell("Timeout: Push voucher", "message")],
      [cell("", "blank"), cell("Wait 2 days, then SMS", "message")],
    ],
    root: start(
      "start",
      PRODUCT_VIEWED,
      waitFor(
        "wait_order",
        ORDER_COMPLETED,
        1,
        "days",
        END,
        push(
          "voucher_push",
          "Quà dành riêng cho bạn",
          "Mộc Lan nhớ bạn! Nhập mã QUAYLAI15 để giảm 15% hôm nay.",
          delay("wait_days", 2, "days", sms("voucher_sms", "Mã QUAYLAI15 giảm 15% tại Mộc Lan sắp hết hạn. Mua ngay nhé.")),
        ),
      ),
      {
        groups: [
          {
            conditions: [
              { type: "behavior", event: ORDER_COMPLETED.name, measure: "COUNT", window: { value: 12, unit: "MONTHS" }, op: ">=", value: 1 },
            ],
          },
        ],
      },
    ),
  },
  {
    key: "post",
    name: "Post-purchase follow-up",
    purpose: "Thank buyers by SMS, then ask for a review 3 days later.",
    needs: [ORDER_COMPLETED],
    channels: "SMS, Push",
    preview: [
      [cell("Start: Order completed", "start")],
      [cell("SMS “Cảm ơn bạn”", "message")],
      [cell("Wait 3 days", "wait")],
      [cell("Push “Đánh giá sản phẩm”", "message")],
    ],
    root: start(
      "start",
      ORDER_COMPLETED,
      sms(
        "thanks_sms",
        "Cảm ơn bạn đã mua sắm tại Mộc Lan. Đơn hàng của bạn đang được chuẩn bị.",
        delay("wait_review", 3, "days", push("review_push", "Đánh giá sản phẩm", "Bạn thấy sản phẩm thế nào? Để lại đánh giá giúp Mộc Lan nhé.")),
      ),
    ),
  },
];

export function templateByKey(key: string): JourneyTemplate | undefined {
  return TEMPLATES.find((template) => template.key === key);
}

/** Template event name to the catalog event the marketer picked, or absent when they picked none. */
export type EventMapping = Readonly<Record<string, string>>;

const EVENT_FIELDS = ["triggerEventName", "eventName", "event"] as const;

// A copy of the tree with every event name the mapping names replaced. An unmapped event keeps the
// template's name, so the checklist blocks publish on it (JBD-FR-29).
function mapEvents(value: unknown, mapping: EventMapping): unknown {
  if (Array.isArray(value)) return value.map((item) => mapEvents(item, mapping));
  if (typeof value !== "object" || value === null) return value;
  const copy: Record<string, unknown> = {};
  for (const [field, child] of Object.entries(value)) {
    const named = (EVENT_FIELDS as readonly string[]).includes(field) && typeof child === "string";
    copy[field] = named ? (mapping[child] ?? child) : mapEvents(child, mapping);
  }
  return copy;
}

export function templateRoot(template: JourneyTemplate, mapping: EventMapping): Record<string, unknown> {
  return mapEvents(template.root, mapping) as Record<string, unknown>;
}

/** The catalog event of each needed event's own name, when the catalog has it. */
export function prefilledMapping(template: JourneyTemplate, catalog: readonly string[]): Record<string, string> {
  const known = new Set(catalog);
  return Object.fromEntries(template.needs.filter((need) => known.has(need.name)).map((need) => [need.name, need.name]));
}

/** The one setup node that Start blank creates. Its event is unset until the marketer picks one. */
export function blankRoot(): Record<string, unknown> {
  return { type: "setup", id: "start", label: "Start", description: "", triggerType: "user", triggerEventName: "", next: [] };
}
