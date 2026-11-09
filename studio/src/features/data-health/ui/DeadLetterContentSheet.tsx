"use client";

import { useEffect, useState } from "react";
import { CopyIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { DeadLetterContent } from "../model/deadLetters";
import { failureMessage, formatBytes } from "../model/deadLetterView";
import { RegionSkeleton } from "@/shared/ui/v2/states";
import { SideSheet } from "@/shared/ui/v2/SideSheet";
import { notify } from "@/shared/ui/v2/toast";

export interface RecordPosition {
  partition: number;
  offset: number;
}

type Loaded = { status: "loading" } | { status: "failed"; message: string } | { status: "gone" } | { status: "ready"; content: DeadLetterContent };

// The parent remounts this sheet per record, so the content of one record is dropped from memory
// when the admin closes it or opens another (DHL-FR-07, DHL-FR-09).
export function DeadLetterContentSheet({ position, onClose }: { position: RecordPosition | null; onClose: () => void }) {
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });

  useEffect(() => {
    if (!position) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ partition: String(position.partition), offset: String(position.offset) });
    fetch(`/v2/data/dead-letters/content?${params}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body: unknown = await response.json().catch(() => null);
        if (response.ok) setLoaded({ status: "ready", content: (body as { content: DeadLetterContent }).content });
        else setLoaded(response.status === 404 ? { status: "gone" } : { status: "failed", message: failureMessage(response.status, body) });
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoaded({ status: "failed", message: failureMessage(0, null) });
      });
    return () => controller.abort();
  }, [position]);

  return (
    <SideSheet
      description={position ? `Partition ${position.partition}, offset ${position.offset}` : undefined}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      open={position !== null}
      title="Record content"
    >
      <ContentBody loaded={loaded} />
    </SideSheet>
  );
}

function ContentBody({ loaded }: { loaded: Loaded }) {
  switch (loaded.status) {
    case "loading":
      return <RegionSkeleton className="h-64" />;
    case "failed":
      return (
        <p className="text-sm" role="alert">
          {loaded.message}
        </p>
      );
    case "gone":
      return <p className="text-muted-foreground text-sm">This record is gone. The topic&apos;s retention removed it.</p>;
    case "ready":
      return <Content content={loaded.content} />;
    default: {
      const unhandled: never = loaded;
      return unhandled;
    }
  }
}

const PRE = "max-h-[60vh] overflow-auto rounded-md border border-border bg-muted p-3 font-mono text-xs";

function Content({ content }: { content: DeadLetterContent }) {
  switch (content.record) {
    case "event":
      return <pre className={PRE}>{JSON.stringify(content.event, null, 2)}</pre>;
    case "payload":
      return <PayloadContent payload={content.payload} size={content.payloadSize} truncated={content.payloadTruncated} />;
    case "unreadable":
      return <p className="text-muted-foreground text-sm">This record is not valid JSON, or its content is missing.</p>;
    default: {
      const unhandled: never = content;
      return unhandled;
    }
  }
}

// A payload is Thrift bytes in Base64. Decoding it is a replay tool's job, so the sheet only shows
// and copies it.
function PayloadContent({ payload, size, truncated }: { payload: string; size: number | null; truncated: boolean }) {
  const copy = () =>
    navigator.clipboard.writeText(payload).then(
      () => notify({ kind: "done", title: "Payload copied" }),
      () => notify({ kind: "failed", title: "Could not copy the payload" }),
    );
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-muted-foreground text-sm">
          Base64 Thrift payload{size !== null && `, ${formatBytes(size)}`}
          {truncated && ", cut to ingestion's payload limit"}
        </p>
        <Button onClick={copy} size="sm" variant="outline">
          <CopyIcon aria-hidden />
          Copy
        </Button>
      </div>
      <pre className={`${PRE} whitespace-pre-wrap break-all`}>{payload}</pre>
    </div>
  );
}
