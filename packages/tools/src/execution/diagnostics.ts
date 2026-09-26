import type { ToolExecutionDiagnostic } from "./isolation-port.ts";
import { bound } from "../lib/output.ts";
import type { ToolResult } from "../tools/content.ts";

/** Describe one admitted tool result without treating command text as OS evidence. */
export function resultDiagnostic(
  result: string | ToolResult,
  toolName: string,
  mode: ToolExecutionDiagnostic["mode"],
  backend: ToolExecutionDiagnostic["backend"],
  policyId: string,
): ToolExecutionDiagnostic {
  const diagnostic: ToolExecutionDiagnostic = {
    mode,
    backend,
    policyId,
    executionStarted: true,
  };
  const content = typeof result === "string" ? result : result.content;
  if (toolName !== "shell" || typeof content !== "string") return diagnostic;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return diagnostic;
  }
  if (typeof parsed !== "object" || parsed === null) return diagnostic;
  const exitCode = parsed.exit_code;
  const signal = parsed.signal;
  const settled = parsed.running === false;
  const failed =
    settled && ((typeof exitCode === "number" && exitCode !== 0) || typeof signal === "string");
  return {
    ...diagnostic,
    ...(settled && (typeof exitCode === "number" || exitCode === null) ? { exitCode } : {}),
    ...(settled && (typeof signal === "string" || signal === null) ? { signal } : {}),
    ...(failed ? { failure: "command_failed" as const } : {}),
    ...(typeof parsed.stdout === "string" ? { stdout: bound(parsed.stdout, 256) } : {}),
    ...(typeof parsed.stderr === "string" ? { stderr: bound(parsed.stderr, 256) } : {}),
  };
}
