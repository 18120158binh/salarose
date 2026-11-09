import "server-only";
import { checkHealth } from "./health";
import { createHealthCache } from "./healthCache";
import { parsePlatformConfig, type PlatformConfig } from "./tools";

let config: PlatformConfig | undefined;

// Parsed on the first request rather than at import, so the build never reads the environment.
export function platformConfig(): PlatformConfig {
  config ??= parsePlatformConfig(process.env);
  return config;
}

export const toolHealth = createHealthCache(
  (check) =>
    checkHealth(check, {
      fetch: (input, init) => fetch(input, init),
      argocdToken: process.env.PLATFORM_ARGOCD_TOKEN?.trim() || undefined,
    }),
  Date.now,
);
