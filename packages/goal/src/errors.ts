/** Stable domain failures mapped explicitly to protocol errors by the host. */
export class GoalError extends Error {
  constructor(
    readonly code:
      | "conflict"
      | "invalid_request"
      | "not_found"
      | "resource_exhausted"
      | "blocked"
      | "budget_limited"
      | "usage_limited",
    message: string,
  ) {
    super(message);
    this.name = "GoalError";
  }
}
