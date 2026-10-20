export function messageFor(error: unknown): string {
  // PowerSync relays worker errors as plain objects, without the Error prototype.
  // Read only the message: other fields can contain request data or credentials.
  const message =
    typeof error === "string"
      ? error
      : typeof error === "object" && error !== null && "message" in error
        ? error.message
        : undefined;

  return typeof message === "string" && message.trim()
    ? message
    : "Something went wrong. Please try again.";
}
