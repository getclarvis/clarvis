/** A busy lease or a changed source revision during an execution-rule replacement. */
export type ExecutionRuleWriteReason = "busy" | "revision_changed";

/** A rule-write conflict whose structured cause is independent of its message. */
export class ExecutionRuleWriteError extends Error {
  readonly reason: ExecutionRuleWriteReason;

  constructor(reason: ExecutionRuleWriteReason, message: string) {
    super(message);
    this.reason = reason;
  }
}
