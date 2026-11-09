import Link from "next/link";
import { SectionCard } from "@/shared/ui/v2/SectionCard";
import { eventsUrl, STUDIO_ADDRESS_PLACEHOLDER } from "../model/ingestAddress";
import { MAX_BATCH_EVENTS } from "../model/businessEvents";
import { CopyButton } from "./CopyButton";

export function eventsCurl(origin: string | null): string {
  return [
    `curl -X POST ${eventsUrl(origin)} \\`,
    '  -H "Authorization: Bearer $ACME_SOURCE_KEY" \\',
    '  -H "Content-Type: application/json" \\',
    "  -d '{",
    '  "events": [{',
    '    "event_id": "6b0c8f3e-1d2a-4c55-9a77-1f0e2d3c4b5a",',
    '    "event_name": "com.acme/purchase",',
    '    "event_time": "2026-11-08T09:13:02+07:00",',
    '    "user_id": "KH-20931",',
    '    "attributes": {',
    '      "order": { "id": "SO-1001", "total": 12990000 }',
    "    }",
    "  }]",
    "}'",
  ].join("\n");
}

const Mono = ({ children }: { children: string }) => <span className="font-mono text-foreground">{children}</span>;

/** The Sources board's side cards: a sample request to POST /v1/events and the batch rules (DHL-FR-17). */
export function SendDataGuide({ origin }: { origin: string | null }) {
  const curl = eventsCurl(origin);
  return (
    <aside className="flex flex-col gap-4">
      <SectionCard title="How to send data">
        <div className="flex flex-col gap-3 text-sm">
          <p className="text-muted-foreground">
            Your developer posts what shoppers do on your servers, like an order, in batches with the source&apos;s key.
          </p>
          <pre className="overflow-x-auto rounded-control bg-muted p-3 font-mono text-xs leading-relaxed">{curl}</pre>
          <div className="flex flex-wrap items-center gap-3">
            <CopyButton text={curl} />
            <span className="text-muted-foreground text-xs">Up to {MAX_BATCH_EVENTS} events or 1 MB per request.</span>
          </div>
          {origin === null && (
            <p className="text-muted-foreground text-xs">
              Studio&apos;s address is not set, so the sample shows <Mono>{STUDIO_ADDRESS_PLACEHOLDER}</Mono>. Use the address you open Studio at.
            </p>
          )}
          <ul className="flex list-disc flex-col gap-1.5 ps-4 text-muted-foreground">
            <li>
              Each event needs an id, a name, a time, and a <Mono>user_id</Mono> or <Mono>anonymous_id</Mono>.
            </li>
            <li>Studio answers with how many it accepted and the reason for each one it refused. One bad event doesn&apos;t block the rest.</li>
            <li>
              Sending the same <Mono>event_id</Mono> twice is safe; it counts once.
            </li>
            <li>
              Events about a product, like <Mono>price_drop</Mono>, go to <Mono>/v1/business-events</Mono> with the same key and no shopper id.
            </li>
          </ul>
        </div>
      </SectionCard>
      <SectionCard title="Your website and app">
        <div className="flex flex-col gap-3 text-sm">
          <p className="text-muted-foreground">
            They send events with the Snowplow tracker to the collector, not through this API, so they need no key here. Ask your developer for
            the tracking guide to add an event such as <Mono>com.acme/add_to_cart</Mono>.
          </p>
          <Link className="font-medium text-primary text-sm hover:underline" href="/v2/data/events">
            See the events Studio knows
          </Link>
        </div>
      </SectionCard>
    </aside>
  );
}
