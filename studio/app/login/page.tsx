import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { CircleAlertIcon, LogInIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { getAuthConfig } from "@/shared/auth/config";
import { AUTH_ERROR_MESSAGES, parseAuthErrorCode } from "@/shared/auth/errors";
import { getSession } from "@/shared/auth/session";
import { signInLinks } from "@/shared/auth/signInLinks";
import { workspaceName } from "@/widgets/v2-shell/model/preferences";
import { SalaroseFonts } from "@/widgets/v2-shell/ui/SalaroseFonts";
import { Horizon, SalaroseMark } from "./_components/brand";

export const metadata: Metadata = { title: "Sign in" };

interface LoginPageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

// AUTH-FR-04: the headings, the subtitle, the links and their order, and the error messages stay as
// the contract states them. The horizon is decoration only.
export default async function LoginPage({ searchParams }: LoginPageProps) {
  if (await getSession()) {
    redirect("/campaign");
  }

  const params = await searchParams;
  const error = parseAuthErrorCode(firstValue(params.error));
  const links = signInLinks(configuredProviders(), firstValue(params.returnTo));
  const isNotAuthorized = error === "not_authorized";

  return (
    <div
      className="relative min-h-screen w-full overflow-hidden bg-[linear-gradient(180deg,var(--sky)_0%,var(--blush)_55%,var(--salt)_56%,var(--background)_100%)] font-sans text-foreground"
      data-salarose=""
    >
      <SalaroseFonts />
      <Horizon />
      <main className="relative flex min-h-screen items-center justify-center px-4 py-6">
        <section
          aria-labelledby="signin-heading"
          className="flex w-full max-w-100 flex-col gap-5 rounded-hero border border-border bg-card px-7 py-8 shadow-hero"
        >
          <div className="flex flex-col items-center gap-2.5 text-center">
            <SalaroseMark />
            <p className="font-semibold text-muted-foreground text-xs uppercase tracking-[0.12em]">
              {workspaceName(process.env.STUDIO_WORKSPACE_NAME)}
            </p>
            <h1 className="font-heading font-semibold text-[1.75rem] tracking-tight" id="signin-heading">
              {isNotAuthorized ? "Not authorized" : "Salarose"}
            </h1>
            {!isNotAuthorized && (
              <p className="max-w-75 text-[0.8125rem] text-muted-foreground">
                Sign in with your company account to build real-time customer journeys.
              </p>
            )}
          </div>

          {error && (
            <Alert variant="error">
              <CircleAlertIcon />
              <AlertDescription>{AUTH_ERROR_MESSAGES[error]}</AlertDescription>
            </Alert>
          )}

          <div className="flex flex-col gap-2.5">
            {links.map((link, index) => (
              // A plain <a>, not next/link: the route redirects off-site to the identity provider.
              <Button
                className="min-h-11 w-full font-semibold"
                key={link.href}
                render={<a href={link.href} />}
                size="lg"
                variant={index === 0 ? "default" : "outline"}
              >
                <LogInIcon />
                {link.label}
              </Button>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}

// The providers to offer, or null when the configuration is missing or invalid. The login route
// logs that error and shows server_error.
function configuredProviders(): { id: string; name: string }[] | null {
  try {
    return [...getAuthConfig().providers.values()];
  } catch {
    return null;
  }
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
