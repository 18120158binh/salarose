import { ExternalLinkIcon } from "lucide-react";
import { Suspense, use } from "react";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { cn } from "@/lib/utils";
import type { Health, HealthStatus } from "../model/health";
import { toolLinks, type ConfiguredTool, type Link, type PlatformConfig, type SignIn, type Tool } from "../model/tools";

export interface PlatformViewProps {
  config: PlatformConfig;
  // The health of a configured tool. It must return the same promise for a tool on every render.
  healthOf: (tool: ConfiguredTool) => Promise<Health>;
  // Studio v2 lays the page out in its shell, so it drops the classic page's width and padding.
  className?: string;
}

const SIGN_IN_TEXT: Record<SignIn, string> = { sso: "Single sign-on", "own-login": "Own login" };

const BADGE_VARIANT: Record<HealthStatus, BadgeProps["variant"]> = {
  up: "success",
  degraded: "warning",
  down: "error",
  unknown: "outline",
};

export function PlatformView({ config, healthOf, className }: PlatformViewProps) {
  return (
    <div className={cn("mx-auto flex max-w-6xl flex-col gap-10 p-8", className)}>
      <section aria-labelledby="platform-tools" className="flex flex-col gap-4">
        <h2 id="platform-tools" className="font-semibold text-lg">
          Tools
        </h2>
        {config.tools.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No tools</EmptyTitle>
              <EmptyDescription>{config.problem ?? "PLATFORM_TOOLS lists no tools."}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {config.tools.map((tool) => (
              <li key={tool.id} className="flex">
                <ToolCard tool={tool} healthOf={healthOf} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {config.quickLinks.length > 0 && (
        <section aria-labelledby="platform-quick-links" className="flex flex-col gap-4">
          <h2 id="platform-quick-links" className="font-semibold text-lg">
            Quick links
          </h2>
          <ul className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            {config.quickLinks.map((link) => (
              <li key={`${link.label} ${link.url}`}>
                <ExternalLink link={link} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function ToolCard({ tool, healthOf }: { tool: Tool; healthOf: PlatformViewProps["healthOf"] }) {
  if (tool.status === "not-configured") {
    return (
      <Card className="flex-1">
        <CardHeader>
          <CardTitle render={<h3 />}>{tool.name}</CardTitle>
          <CardDescription>The configuration of this tool is missing or invalid.</CardDescription>
        </CardHeader>
        <CardPanel>
          <HealthLine health={{ status: "unknown", reason: "not configured" }} />
        </CardPanel>
      </Card>
    );
  }

  const links = toolLinks(tool);
  return (
    <Card className="flex-1">
      <CardHeader>
        <CardTitle render={<h3 />}>{tool.name}</CardTitle>
        <CardDescription>{tool.purpose}</CardDescription>
      </CardHeader>
      <CardPanel className="flex flex-col gap-3 text-sm">
        {/* The live region stays mounted while Suspense swaps its content, so the result is announced. */}
        <div aria-live="polite" aria-atomic="true">
          <Suspense fallback={<HealthLine health={null} />}>
            <ToolHealth health={healthOf(tool)} />
          </Suspense>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt className="text-muted-foreground">Address</dt>
          <dd className="min-w-0 truncate">
            <ExternalLink link={{ label: tool.url.replace(/^https?:\/\//, ""), url: tool.url }} />
          </dd>
          <dt className="text-muted-foreground">Sign-in</dt>
          <dd>{SIGN_IN_TEXT[tool.signIn]}</dd>
        </dl>
        {links.length > 0 && (
          <ul className="flex flex-wrap gap-x-4 gap-y-1">
            {links.map((link) => (
              <li key={`${link.label} ${link.url}`}>
                <ExternalLink link={link} />
              </li>
            ))}
          </ul>
        )}
      </CardPanel>
    </Card>
  );
}

function ToolHealth({ health }: { health: Promise<Health> }) {
  return <HealthLine health={use(health)} />;
}

// health is null while the check runs.
function HealthLine({ health }: { health: Health | null }) {
  return (
    <p className="flex items-center gap-2">
      <Badge variant={health ? BADGE_VARIANT[health.status] : "secondary"}>{health ? health.status : "checking"}</Badge>
      <span className="text-muted-foreground">{health ? health.reason : "Checking health…"}</span>
    </p>
  );
}

function ExternalLink({ link }: { link: Link }) {
  return (
    <a
      href={link.url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-foreground underline underline-offset-4 hover:text-muted-foreground"
    >
      {link.label}
      <ExternalLinkIcon aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}
