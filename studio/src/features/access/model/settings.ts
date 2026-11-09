import { parseModelConfig } from "@/app/api/generate-journey/modelConfig";
import { parseRateLimits, type RateLimits } from "@/app/api/generate-journey/rateLimit";
import type { AuthConfig } from "@/shared/auth/config";
import type { SystemRole } from "@/shared/auth/types";
import { workspaceName } from "@/widgets/v2-shell/model/preferences";

type Env = Record<string, string | undefined>;

// SHL-FR-20: what the settings page may show. Only names, lengths, and counts, so no secret, client
// id, or key can reach the page through this shape.
export interface WorkspaceSettings {
  workspace: string;
  // Null when the sign-in configuration does not parse.
  providers: readonly string[] | null;
  sessionSeconds: number | null;
  aiGenerationConfigured: boolean;
  // Null when a limit is invalid, which makes AI generation refuse every request.
  rateLimits: RateLimits | null;
}

export const ROLE_LABELS: Record<SystemRole, string> = { admin: "Admin", editor: "Editor" };

export interface PreviewStaff {
  email: string;
  role: SystemRole;
}

export function workspaceSettings(env: Env, authConfig: () => AuthConfig): WorkspaceSettings {
  const auth = attempt(authConfig);
  return {
    workspace: workspaceName(env.STUDIO_WORKSPACE_NAME),
    providers: auth && [...auth.providers.values()].map((provider) => provider.name),
    sessionSeconds: auth && auth.sessionMaxAgeSeconds,
    aiGenerationConfigured: parseModelConfig(env) !== null,
    rateLimits: attempt(() => parseRateLimits(env)),
  };
}

function attempt<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}
