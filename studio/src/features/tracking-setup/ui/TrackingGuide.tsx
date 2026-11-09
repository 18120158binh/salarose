"use client";

import Link from "next/link";
import { use, useState, type ReactNode } from "react";
import { ArrowRightIcon, ArrowUpRightIcon, CheckIcon, ClockIcon, GlobeIcon, InfoIcon, KeyRoundIcon, ServerIcon, type LucideIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { CopyButton } from "@/features/data-ingestion/ui/CopyButton";
import { DataRegion } from "@/shared/ui/v2/DataRegion";
import { RegionSkeleton } from "@/shared/ui/v2/states";
import type { EventVolume } from "@/features/data-health/model/eventVolume";
import { formatTimestamp } from "@/shared/lib/format";
import type { TimeZone } from "@/shared/lib/time-range";
import { SAMPLE_EVENTS, sampleName, type SampleKey, type TrackingPlan } from "../model/plan";
import { APP_ID_PLACEHOLDER, COLLECTOR_PLACEHOLDER, eventCode, IDENTIFY_CODE, installCode, personEventCode } from "../model/samples";

type Channel = "website" | "server";

export interface TrackingGuideProps {
  // Null or empty while the deployment does not name them (DHL-FR-15): the samples show a placeholder.
  collector: string | null;
  appIds: readonly string[];
  // Where a server posts person events (DIA-FR-07).
  eventsUrl: string;
  admin: boolean;
  plan: Promise<TrackingPlan>;
  // DHL-FR-14: the three sample events' volume today, from event_volume, in SAMPLE_EVENTS order.
  arrivals: Promise<EventVolume[]>;
  now: number;
  zone: TimeZone;
}

function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono text-foreground">{children}</span>;
}

function Code({ label, code }: { label: string; code: string }) {
  return (
    <div className="flex flex-col overflow-hidden rounded-control border border-border">
      <div className="flex items-center justify-between gap-2 border-border border-b bg-muted px-3 py-1.5">
        <span className="text-muted-foreground text-xs">{label}</span>
        <CopyButton text={code} />
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-xs leading-relaxed">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function Tips({ children }: { children: ReactNode }) {
  return <ul className="flex list-disc flex-col gap-1.5 ps-4 text-muted-foreground text-sm">{children}</ul>;
}

function Step({ n, title, aside, children }: { n: number; title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <article aria-labelledby={`h-step-${n}`} className="flex gap-4 rounded-card border border-border bg-card p-4" id={`step-${n}`}>
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 font-heading font-semibold text-primary text-sm tabular-nums">
        {n}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-heading font-semibold text-[0.9375rem]" id={`h-step-${n}`}>
            {title}
          </h2>
          {aside}
        </div>
        {children}
      </div>
    </article>
  );
}

function ReadonlyField({ id, label, value, note }: { id: string; label: string; value: string; note: string }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input className="font-mono" id={id} readOnly value={value} />
      <span className="text-muted-foreground text-xs">{note}</span>
    </div>
  );
}

function appIdNote(appIds: readonly string[]): string {
  if (appIds.length === 0) return "Studio does not know it yet. Choose one per site or app.";
  if (appIds.length === 1) return "Names where each event came from. One per site or app.";
  return `Names where each event came from. Your other sites and apps use ${appIds.slice(1).join(", ")}.`;
}

function Arrivals({ arrivals, now, zone }: { arrivals: Promise<EventVolume[]>; now: number; zone: TimeZone }) {
  const volumes = use(arrivals);
  return (
    <ul aria-label="Whether your first events arrived" className="flex w-full flex-col gap-1.5">
      {SAMPLE_EVENTS.map(({ key, label }) => {
        const volume = volumes.find((entry) => entry.eventName === sampleName(key));
        const seen = volume?.lastSeenAt ? formatTimestamp(Date.parse(volume.lastSeenAt), now, zone) : null;
        return (
          <li className="flex flex-wrap items-center gap-2" key={key}>
            {seen ? <CheckIcon aria-hidden className="size-4 text-success" /> : <ClockIcon aria-hidden className="size-4 text-muted-foreground" />}
            <span className="font-medium">{label}</span>
            <Mono>{sampleName(key)}</Mono>
            <span className="ms-auto text-muted-foreground">
              {seen ? (
                <>
                  Last seen <time title={seen.exact}>{seen.text}</time>
                </>
              ) : (
                "Not yet"
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function SampleFields({ plan, sample }: { plan: Promise<TrackingPlan>; sample: SampleKey }) {
  const event = use(plan).samples[sample];
  if (event === null) {
    return (
      <p className="flex items-start gap-2 rounded-control border border-border p-3 text-muted-foreground text-sm">
        <InfoIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
        <span>
          Events has no active event named <Mono>{sampleName(sample)}</Mono>. Add it there before you send it, or journeys never see it.
        </span>
      </p>
    );
  }
  return (
    <>
      {event.attributes.length > 0 && (
        <div className="rounded-control border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Field</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Must be sent</TableHead>
                <TableHead>Example</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {event.attributes.map((field) => (
                <TableRow key={field.path}>
                  <TableCell className="font-mono">{field.path}</TableCell>
                  <TableCell>{field.type}</TableCell>
                  <TableCell>{field.required ? "Yes" : "No"}</TableCell>
                  <TableCell className="font-mono text-muted-foreground">{field.example ?? "Not recorded"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <p className="text-muted-foreground text-sm">
        {event.strict
          ? "Strict: an event missing a field that must be sent, or with the wrong type, is dropped. Dropped events are kept for 7 days in Monitoring › Dropped data, then deleted."
          : "Accepts all: nothing must be sent, but journeys can only test the fields you send."}
      </p>
    </>
  );
}

function ChannelCard({ on, icon: Icon, title, body, onPick }: { on: boolean; icon: LucideIcon; title: string; body: string; onPick: () => void }) {
  return (
    <button
      aria-pressed={on}
      className={cn("flex flex-1 flex-col gap-1 rounded-tile border p-3 text-start", on ? "border-primary bg-primary/8" : "border-border bg-card hover:bg-muted")}
      onClick={onPick}
      type="button"
    >
      <span className="flex items-center gap-2 font-medium text-sm">
        <Icon aria-hidden className="size-4" />
        {title}
        {on && <CheckIcon aria-hidden className="ms-auto size-4 text-primary" />}
      </span>
      <span className="text-muted-foreground text-xs">{body}</span>
    </button>
  );
}

/** DHL-FR-15, DHL-FR-16: the Tracking setup steps for a website or a server. */
export function TrackingGuide({ collector, appIds, eventsUrl, admin, plan, arrivals, now, zone }: TrackingGuideProps) {
  const [channel, setChannel] = useState<Channel>("website");
  const [sample, setSample] = useState<SampleKey>("add_to_cart");
  const web = channel === "website";
  const collectorShown = collector ?? COLLECTOR_PLACEHOLDER;
  const appIdShown = appIds[0] ?? APP_ID_PLACEHOLDER;
  const sampleLabel = SAMPLE_EVENTS.find((entry) => entry.key === sample)?.label ?? sample;
  const steps = ["Choose how you send", web ? "Install the tracker" : "Get a source key", "Identify the shopper", "Send first events", "Check it arrived"];

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <nav aria-label="Setup steps">
        <ol className="flex flex-wrap items-center gap-2">
          {steps.map((label, index) => (
            <li className="flex items-center gap-2" key={label}>
              <a className="flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-sm hover:bg-muted" href={`#step-${index + 1}`}>
                <span className="font-heading font-semibold text-primary tabular-nums">{index + 1}</span>
                <span>{label}</span>
              </a>
              {index < steps.length - 1 && <span aria-hidden className="h-px w-4 bg-border" />}
            </li>
          ))}
        </ol>
      </nav>

      <Step n={1} title="Choose how you send data">
        <p className="text-muted-foreground text-sm">Most shops use both: the website tracker for browsing, and the server for paid orders. Set up one at a time.</p>
        <div aria-label="How you send data" className="flex flex-col gap-2 sm:flex-row" role="group">
          <ChannelCard
            body="A small script on your shop's pages sends product views, carts and sign-ins from the browser. Snowplow-compatible."
            icon={GlobeIcon}
            on={web}
            onPick={() => setChannel("website")}
            title="Website (JavaScript)"
          />
          <ChannelCard
            body="Your servers post JSON for what the browser doesn't see: paid orders, refunds, price drops."
            icon={ServerIcon}
            on={!web}
            onPick={() => setChannel("server")}
            title="Server (HTTP API)"
          />
        </div>
        <p className="text-muted-foreground text-sm">
          Mobile apps (iOS, Android) use the Snowplow mobile trackers with the same collector address. Keep their session context on: it carries the
          phone&apos;s device id.
        </p>
      </Step>

      {web ? (
        <>
          <Step n={2} title="Install the tracker">
            <p className="text-muted-foreground text-sm">Add it once, on every page of your shop. It sends to your own collector address.</p>
            <div className="flex flex-col gap-3 sm:flex-row">
              <ReadonlyField
                id="collector-address"
                label="Collector address"
                note={collector === null ? "Studio does not know it yet. Ask whoever runs your collector." : "On your own domain, so the cookie counts as your shop's."}
                value={collectorShown}
              />
              <ReadonlyField
                id="tracker-app-id"
                label="App id"
                note={appIdNote(appIds)}
                value={appIdShown}
              />
            </div>
            <Code code={installCode(collectorShown, appIdShown)} label="JavaScript" />
            <Tips>
              <li>
                Keep <Mono>eventMethod: &apos;post&apos;</Mono>. Long events sent as a link can be cut off.
              </li>
              <li>
                Set <Mono>cookieDomain</Mono> to your main domain, so a shopper keeps one device id across <Mono>acme.com</Mono> and{" "}
                <Mono>m.acme.com</Mono>.
              </li>
              <li>Don&apos;t turn on anonymous tracking. It blanks the device id, and every visitor becomes one person.</li>
            </Tips>
          </Step>
          <Step n={3} title="Identify the shopper">
            <p className="text-muted-foreground text-sm">
              Before login, the tracker&apos;s cookie gives each browser a device id; you do nothing. After login, tell the tracker who it is, so the
              phone and the laptop become one customer.
            </p>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="rounded-control border border-border px-2.5 py-1.5">
                <span className="text-muted-foreground text-xs">Before login</span> Device id <Mono>a1b2c3d4…</Mono>
              </span>
              <ArrowRightIcon aria-hidden className="size-4 text-muted-foreground" />
              <span className="rounded-control border border-border px-2.5 py-1.5">
                <span className="text-muted-foreground text-xs">After login</span> User id <Mono>KH-20931</Mono>
              </span>
              <ArrowRightIcon aria-hidden className="size-4 text-muted-foreground" />
              <span className="rounded-control border border-primary/40 bg-primary/8 px-2.5 py-1.5 font-medium">One customer</span>
            </div>
            <Code code={IDENTIFY_CODE} label="JavaScript" />
            <Tips>
              <li>Send the same user id everywhere: website, apps, servers, and the customer key in your customer list.</li>
              <li>
                Never send a stand-in like <Mono>guest</Mono> or <Mono>0</Mono>. Every event that carries it becomes one person. Blank,{" "}
                <Mono>unknown</Mono>, <Mono>undefined</Mono> and <Mono>null</Mono> are ignored.
              </li>
              <li>An event with neither a device id nor a user id is kept but never reaches a journey.</li>
            </Tips>
          </Step>
          <Step n={4} title="Send your first events">
            <p className="text-muted-foreground text-sm">
              Start with these three. Each is a self-describing event: its schema names it, like <Mono>com.acme/add_to_cart</Mono>. That name must
              match an event in{" "}
              <Link className="text-primary hover:underline" href="/v2/data/events">
                Events
              </Link>{" "}
              exactly, or journeys never see it.
            </p>
            <div aria-label="Sample event" className="flex flex-wrap gap-2" role="group">
              {SAMPLE_EVENTS.map((entry) => (
                <button
                  aria-pressed={entry.key === sample}
                  className={cn(
                    "flex flex-col items-start rounded-control border px-3 py-1.5 text-start text-sm",
                    entry.key === sample ? "border-primary bg-primary/8" : "border-border hover:bg-muted",
                  )}
                  key={entry.key}
                  onClick={() => setSample(entry.key)}
                  type="button"
                >
                  {entry.label}
                  <span className="font-mono text-muted-foreground text-xs">{sampleName(entry.key)}</span>
                </button>
              ))}
            </div>
            <Code code={eventCode(sample)} label={`JavaScript · ${sampleLabel}`} />
            <DataRegion errorMessage="The event's fields could not load." loading={<RegionSkeleton className="h-24" />}>
              <SampleFields plan={plan} sample={sample} />
            </DataRegion>
            <Tips>
              <li>
                Send numbers as numbers: <Mono>price: 1290000</Mono>, not <Mono>&quot;1.290.000 ₫&quot;</Mono>. Number conditions need a number.
              </li>
              <li>
                Put every field in the event&apos;s <Mono>data</Mono>. Extra blocks attached to an event (contexts) are dropped.
              </li>
              <li>
                Avoid the field names Studio uses itself: <Mono>event.name</Mono>, <Mono>page.url</Mono>, <Mono>page.location</Mono>,{" "}
                <Mono>page.referrer</Mono>, <Mono>product.name</Mono>. Keep each event under 32 KB.
              </li>
            </Tips>
          </Step>
        </>
      ) : (
        <>
          <Step n={2} title="Get a source key">
            <p className="text-muted-foreground text-sm">
              Each server that sends data gets its own key, named after it, like <Mono>order-service</Mono>. Keep it on the server: never in a web
              page or an app.
            </p>
            <div className="flex flex-col gap-3 sm:flex-row">
              <ReadonlyField id="events-address" label="Address" note="HTTPS only." value={eventsUrl} />
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <span className="font-medium text-sm">Header</span>
                <span className="rounded-control border border-border bg-muted px-3 py-2 font-mono text-sm">Authorization: Bearer &lt;source key&gt;</span>
              </div>
            </div>
            {admin ? (
              <p className="flex flex-wrap items-center gap-2 text-sm">
                <Link className="inline-flex items-center gap-1.5 font-medium text-primary hover:underline" href="/v2/data/sources">
                  <KeyRoundIcon aria-hidden className="size-4" />
                  Create a source key in Sources
                </Link>
                <span className="text-muted-foreground">The key shows once. Studio keeps only a fingerprint of it.</span>
              </p>
            ) : (
              <p className="flex items-center gap-2 text-muted-foreground text-sm">
                <InfoIcon aria-hidden className="size-4" />
                Ask an admin to create a key in Sources and give it to your developer.
              </p>
            )}
          </Step>
          <Step n={3} title="Identify the shopper">
            <p className="text-muted-foreground text-sm">
              Every event names who did it, with at least one of these. Use the same values your website sends, so the order joins the shopper who
              browsed.
            </p>
            <div className="rounded-control border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Field</TableHead>
                    <TableHead>What to send</TableHead>
                    <TableHead>Example</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow>
                    <TableCell className="font-mono">user_id</TableCell>
                    <TableCell className="whitespace-normal">The account id of a signed-in shopper, the same as the website&apos;s user id</TableCell>
                    <TableCell className="font-mono">KH-20931</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell className="font-mono">anonymous_id</TableCell>
                    <TableCell className="whitespace-normal">
                      The browser&apos;s device id, when you know it, for example from the request that placed the order
                    </TableCell>
                    <TableCell className="font-mono">a1b2c3d4-5e6f-4a7b-…</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
            <Tips>
              <li>An event with neither is refused, because it could never reach a journey.</li>
              <li>
                Never send a stand-in like <Mono>guest</Mono> or <Mono>0</Mono>. Every event that carries it becomes one person.
              </li>
            </Tips>
          </Step>
          <Step n={4} title="Send your first events">
            <p className="text-muted-foreground text-sm">
              Post up to 500 events, or 1 MB, per request. Studio answers with how many it accepted and the reason for each one it refused. One bad
              event doesn&apos;t block the rest, and sending the same <Mono>event_id</Mono> twice counts once.
            </p>
            <Code code={personEventCode(eventsUrl)} label="Request" />
            <Tips>
              <li>
                Events about a product, like <Mono>price_drop</Mono>: post them to <Mono>/v1/business-events</Mono> with the same key, without a
                user id. Studio finds the shoppers they concern.
              </li>
            </Tips>
          </Step>
        </>
      )}

      <Step n={5} title="Check it arrived">
        <div className="flex flex-wrap items-center gap-3 rounded-control border border-border p-3 text-sm">
          <DataRegion errorMessage="Whether your events arrived could not load." loading={<RegionSkeleton className="h-16 w-full" />}>
            <Arrivals arrivals={arrivals} now={now} zone={zone} />
          </DataRegion>
          <Link className="ms-auto inline-flex items-center gap-1 font-medium text-primary hover:underline" href="/v2/data/monitoring">
            Open Monitoring to see your events arrive
            <ArrowUpRightIcon aria-hidden className="size-4" />
          </Link>
        </div>
        <p className="text-muted-foreground text-sm">A dropped event leaves no error on your side. Monitoring shows what was dropped and why.</p>
      </Step>
    </div>
  );
}
