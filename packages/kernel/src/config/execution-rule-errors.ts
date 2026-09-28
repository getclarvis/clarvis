import { ExecutionRuleWriteError } from "../execution/execpolicy-errors.ts";
import { kernelError } from "../core/errors.ts";

function assertNever(_reason: never): never {
  throw new Error("Unknown execution rule write reason");
}

/** Map recognized rule-write conflicts at the configuration-service boundary. */
export function mapExecutionRuleWriteError(error: unknown): unknown {
  if (!(error instanceof ExecutionRuleWriteError)) return error;
  switch (error.reason) {
    case "busy":
    case "revision_changed":
      return kernelError("conflict", String(error));
    default:
      return assertNever(error.reason);
  }
}
