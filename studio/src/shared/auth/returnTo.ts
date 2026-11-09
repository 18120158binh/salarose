const DEFAULT_RETURN_TO = "/campaign";
const MAX_RETURN_TO_LENGTH = 2048;

// Returns a same-origin path to send the user to after sign-in, or /campaign.
export function sanitizeReturnTo(value: string | null): string {
  if (
    value === null ||
    value.length > MAX_RETURN_TO_LENGTH ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.startsWith("/\\") ||
    value.startsWith("/login") ||
    value.startsWith("/api/") ||
    hasControlCharOrSpace(value)
  ) {
    return DEFAULT_RETURN_TO;
  }
  return value;
}

// Browsers and the URL parser drop tabs and newlines, so "/\t/evil.example" would become
// "//evil.example". Reject every control character and space instead of normalizing.
function hasControlCharOrSpace(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}
