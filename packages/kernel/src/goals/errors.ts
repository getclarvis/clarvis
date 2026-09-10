import { GoalError } from "@clarvis/goal";
import { ZodError } from "zod";
import { KernelException, kernelError } from "../core/errors.ts";

/** Map domain failures without exposing objective text, evidence payloads or storage exception details. */
export function toGoalKernelError(error: unknown): KernelException {
  if (error instanceof KernelException) return error;
  if (error instanceof ZodError)
    return kernelError("invalid_request", "Invalid goal control arguments");
  if (error instanceof GoalError) {
    switch (error.code) {
      case "blocked":
        return kernelError("conflict", "Goal execution requires intervention", {
          goal_code: error.code,
        });
      case "budget_limited":
      case "usage_limited":
        return kernelError("resource_exhausted", "Goal continuation limit reached", {
          goal_code: error.code,
        });
      case "resource_exhausted":
        return kernelError(error.code, "Goal operation exceeds its resource bound");
      case "conflict":
        return kernelError(error.code, "Goal state or execution authority changed");
      case "not_found":
        return kernelError(error.code, "Bound goal was not found");
      case "invalid_request":
        return kernelError(error.code, "Goal control or evidence is invalid");
    }
  }
  return kernelError("internal", "Goal state operation failed");
}
