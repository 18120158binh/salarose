const LOGIN_ROUTE = "/api/auth/oidc/login";

export interface SignInLink {
  label: string;
  href: string;
}

// The login page's links, one per provider. Without the provider configuration, one link with no
// provider, so the login route reports the configuration error.
export function signInLinks(
  providers: readonly { id: string; name: string }[] | null,
  returnTo: string | undefined,
): SignInLink[] {
  const link = (label: string, provider?: string): SignInLink => {
    const params = new URLSearchParams();
    if (provider !== undefined) params.set("provider", provider);
    if (returnTo) params.set("returnTo", returnTo);
    const query = params.toString();
    return { label, href: query ? `${LOGIN_ROUTE}?${query}` : LOGIN_ROUTE };
  };
  if (providers === null) return [link("Sign in with SSO")];
  return providers.map((provider) => link(`Sign in with ${provider.name}`, provider.id));
}
