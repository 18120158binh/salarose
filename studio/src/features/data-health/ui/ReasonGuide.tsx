import { SectionCard } from "@/shared/ui/v2/SectionCard";
import type { ReasonChoice } from "../model/deadLetterQuery";
import { REASON_LABELS } from "../model/deadLetterView";

const MEANINGS: readonly { reason: ReasonChoice; meaning: string }[] = [
  { reason: "schema_invalid", meaning: "The event is Strict and missed a Must be sent field or sent the wrong type. The detail names the field." },
  { reason: "no_timestamp", meaning: "The tracker sent no time Studio could use." },
  { reason: "invalid_event_id", meaning: "Each event needs a unique id so it is never counted twice." },
  { reason: "event_not_decoded", meaning: "One event inside a request was garbled. The rest of the request was used." },
  { reason: "payload_not_decoded", meaning: "The whole request from the tracker was unreadable." },
  { reason: "grouped", meaning: "The request that carried dropped events. Same request id as they have." },
];

// DHL-FR-06: each reason's plain label, its code, and what it means.
export function ReasonGuide() {
  return (
    <SectionCard title="What the reasons mean">
      <dl className="flex flex-col gap-3 text-sm">
        {MEANINGS.map(({ reason, meaning }) => (
          <div className="flex flex-col gap-0.5" key={reason}>
            <dt className="font-medium">
              {REASON_LABELS[reason]}
              {reason !== "grouped" && <span className="ml-1.5 font-mono text-muted-foreground text-xs">{reason}</span>}
            </dt>
            <dd className="text-muted-foreground">{meaning}</dd>
          </div>
        ))}
      </dl>
    </SectionCard>
  );
}
