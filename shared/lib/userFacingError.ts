// An error whose message is written for the staff user: a refused request, such as a malformed
// journey, a metric in use, or a missing permission. Server actions show its message. Any other
// error, such as a Postgres failure, can name constraints and columns and quote row values, so
// actions log it and show a fixed message instead.
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserFacingError";
  }
}

export function userFacingMessage(error: unknown, fallback: string): string {
  return error instanceof UserFacingError ? error.message : fallback;
}
