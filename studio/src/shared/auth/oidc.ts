import "server-only";
import { allowInsecureRequests, discovery, type Configuration } from "openid-client";
import type { OidcProvider } from "./config";

const configurations = new Map<string, Promise<Configuration>>();

// Discovers each provider once per process. A failed discovery is not cached, so the next
// sign-in retries it.
export function getOidcConfiguration(provider: OidcProvider): Promise<Configuration> {
  const cached = configurations.get(provider.id);
  if (cached) return cached;

  const allowHttp = provider.issuer.protocol === "http:" && process.env.NODE_ENV !== "production";
  const pending = discovery(
    provider.issuer,
    provider.clientId,
    provider.clientSecret,
    undefined,
    allowHttp ? { execute: [allowInsecureRequests] } : undefined,
  );
  configurations.set(provider.id, pending);
  pending.catch(() => {
    if (configurations.get(provider.id) === pending) configurations.delete(provider.id);
  });
  return pending;
}
