import { sampleName, type SampleKey } from "./plan";

// Shown in a sample when Studio has no setting that names the value (DHL-FR-15): the deployment
// does not tell Studio its collector address or app ids yet.
export const COLLECTOR_PLACEHOLDER = "https://<collector address>";
export const APP_ID_PLACEHOLDER = "<app id>";

export function installCode(collector: string, appId: string): string {
  return [
    "npm install @snowplow/browser-tracker",
    "",
    "import { newTracker, trackPageView } from '@snowplow/browser-tracker';",
    "",
    `newTracker('sp', '${collector}', {`,
    `  appId: '${appId}',`,
    "  eventMethod: 'post',",
    "  encodeBase64: false,",
    "  cookieDomain: '.acme.com',",
    "  contexts: { session: true },",
    "});",
    "",
    "trackPageView();",
  ].join("\n");
}

export const IDENTIFY_CODE = [
  "import { setUserId } from '@snowplow/browser-tracker';",
  "",
  "// After login, and on every page load while signed in:",
  "setUserId('KH-20931');",
  "",
  "// After logout:",
  "setUserId(null);",
].join("\n");

// The tracking guide wins over the drafts: no sample sends product.name, a field Studio uses itself.
const SAMPLE_DATA: Record<SampleKey, readonly string[]> = {
  product_viewed: ["      product: { id: 'SP-AD-0412', title: 'Áo dài lụa Hà Đông', price: 1290000, category: 'Áo dài' },"],
  add_to_cart: ["      product: { id: 'SP-AD-0412', title: 'Áo dài lụa Hà Đông', price: 1290000 },", "      quantity: 1,"],
  order_completed: ["      order: { id: 'DH-58213', total: 1290000, item_count: 1, payment: 'cod' },", "      voucher: { code: 'ACME50K' },"],
};

export function eventCode(key: SampleKey): string {
  return [
    "import { trackSelfDescribingEvent } from '@snowplow/browser-tracker';",
    "",
    "trackSelfDescribingEvent({",
    "  event: {",
    `    schema: 'iglu:${sampleName(key)}/jsonschema/1-0-0',`,
    "    data: {",
    ...SAMPLE_DATA[key],
    "    },",
    "  },",
    "});",
  ].join("\n");
}

export function personEventCode(url: string): string {
  return [
    `POST ${url}`,
    "Authorization: Bearer <source key>",
    "",
    "{ \"events\": [ {",
    '  "event_id": "6b0c8f3e-1d2a-4c55-9a77-1f0e2d3c4b5a",',
    '  "event_name": "com.acme/purchase",',
    '  "event_time": "2026-11-08T09:13:02+07:00",',
    '  "user_id": "KH-20931",',
    '  "attributes": { "order": { "id": "SO-1001", "total": 12990000 } }',
    "} ] }",
  ].join("\n");
}

export const DROPS: readonly { what: string; then: string }[] = [
  { what: "No event id, or not a UUID", then: "Dropped" },
  { what: "No time on the event", then: "Dropped" },
  { what: "Neither a device id nor a user id", then: "Kept, but never reaches a journey" },
  { what: "More than 32 KB of data", then: "Dropped before journeys" },
  { what: "A Strict event that does not fit", then: "Dropped. Monitoring shows why." },
  { what: "The same event id twice", then: "Counted once" },
];
