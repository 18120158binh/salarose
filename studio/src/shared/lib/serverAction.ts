export const SERVER_UNREACHABLE = "The server could not be reached. Try again.";

// Calls a server action that reports its own failures as { error }. The call itself can still
// reject, after a network failure or a deploy that removed the action, so that becomes an error
// result too, and the caller handles one shape.
export async function callServerAction<T extends object>(
  call: () => Promise<T>,
): Promise<T | { error: string }> {
  try {
    return await call();
  } catch (error) {
    console.error("A server action could not be called:", error);
    return { error: SERVER_UNREACHABLE };
  }
}
