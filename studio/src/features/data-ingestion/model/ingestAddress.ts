// Studio's public address is the origin of its sign-in callback (OIDC_REDIRECT_URL), the one
// setting that names the host people reach Studio at. The data ingestion API is served there.
// Null when the setting is missing or not a URL, so a page shows a placeholder instead of a guess.
export function studioOrigin(env: Readonly<Record<string, string | undefined>>): string | null {
  const value = env.OIDC_REDIRECT_URL;
  if (value === undefined || value.trim() === "") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

export const STUDIO_ADDRESS_PLACEHOLDER = "https://<studio address>";

export function eventsUrl(origin: string | null): string {
  return `${origin ?? STUDIO_ADDRESS_PLACEHOLDER}/v1/events`;
}
