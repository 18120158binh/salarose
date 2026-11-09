import { cookies } from "next/headers";
import { LogOutIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { signInDetails } from "@/features/access/model/server";
import { ROLE_LABELS } from "@/features/access/model/settings";
import { DetailList } from "@/features/access/ui/DetailList";
import { formatDateTime } from "@/shared/lib/format";
import { parseTimeZone, TZ_COOKIE } from "@/shared/lib/time-range";
import { PageHeader } from "@/shared/ui/v2/PageHeader";
import { Forbidden } from "@/shared/ui/v2/states";
import { initials, workspaceName } from "@/widgets/v2-shell/model/preferences";
import { openRoute, viewerReach } from "@/widgets/v2-shell/model/viewer";

export const dynamic = "force-dynamic";

// SHL-FR-19: any staff user's own sign-in details and preferences. The identity provider owns the
// email and the role, so nothing here edits them.
export default async function V2AccountPage() {
  const viewer = await openRoute("account");
  if (!viewer) return <Forbidden />;
  const [cookieStore, signIn, reach] = await Promise.all([cookies(), signInDetails(), viewerReach()]);
  const zone = parseTimeZone(cookieStore.get(TZ_COOKIE)?.value);

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <PageHeader description="Your identity provider manages your email and role." preview title="Account" />
      {/* The session holds no name, so the email stands in for it (SHL-FR-19). */}
      <section aria-label="Your profile" className="flex flex-wrap items-center gap-4 rounded-card border border-border bg-card px-4 py-4">
        <span
          aria-hidden
          className="flex size-12 shrink-0 items-center justify-center rounded-full bg-primary font-heading font-semibold text-primary-foreground"
        >
          {initials(viewer.email)}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="truncate font-heading font-semibold text-[0.9375rem]">{viewer.email}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Badge size="sm" variant="secondary">
              {ROLE_LABELS[viewer.role]}
            </Badge>
            <Badge size="sm" variant="outline">
              {workspaceName(process.env.STUDIO_WORKSPACE_NAME)}
            </Badge>
          </div>
        </div>
        <form action="/api/auth/logout" className="flex flex-col items-end gap-1" method="post">
          <Button type="submit" variant="outline">
            <LogOutIcon aria-hidden />
            Sign out
          </Button>
          <span className="text-muted-foreground text-xs">Ends every Studio session you have open.</span>
        </form>
      </section>
      <DetailList
        details={[
          { label: "Email", value: viewer.email },
          {
            label: "Role",
            value: (
              <Badge size="sm" variant="secondary">
                {ROLE_LABELS[viewer.role]}
              </Badge>
            ),
          },
          { label: "Signed in with", value: signIn?.provider ?? "Not available" },
          {
            label: "Session expires",
            value: signIn ? formatDateTime(signIn.expiresAt, zone) : "Not available",
            note: "Sign in again after this time.",
          },
          {
            label: "Preview access",
            value: reach.preview ? "On" : "Off",
            note: "Preview access opens new pages before they reach everyone.",
          },
        ]}
        title="Sign-in"
      />
      <DetailList
        details={[
          { label: "Time zone", value: zone, note: "From your browser. Studio shows times and ranges in this zone." },
        ]}
        title="Preferences"
      />
    </div>
  );
}
