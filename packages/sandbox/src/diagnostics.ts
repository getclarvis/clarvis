import type { ExecutionMode } from "./policy.ts";

/** Stable classifications for a single native or Host attempt. */
export type ExecutionFailureCode =
  | "sandbox_unavailable"
  | "sandbox_setup_failed"
  | "sandbox_denied"
  | "command_failed"
  | "aborted"
  | "outcome_unknown";

/** A setup failure before the protected child has started. */
export class SandboxSetupError extends Error {
  readonly executionStarted = false;

  constructor(
    readonly code: "sandbox_unavailable" | "sandbox_setup_failed",
    message: string,
    readonly boundary?: { readonly backend: "bubblewrap" | "seatbelt"; readonly policyId: string },
  ) {
    super(message);
    this.name = "SandboxSetupError";
  }

  /** Attribute a pre-launch failure to the selected policy without changing its classification. */
  withBoundary(backend: "bubblewrap" | "seatbelt", policyId: string): SandboxSetupError {
    return new SandboxSetupError(this.code, this.message, { backend, policyId });
  }
}

/** A backend's effective capabilities, which may differ across operating systems. */
export interface BackendCapabilities {
  readonly pidNamespace: boolean;
  readonly mountNamespace: boolean;
  readonly ipcNamespace: boolean;
  readonly networkIsolation: boolean;
}

/** Evidence of the actual execution boundary, attached to an attempt. */
export interface ExecutionDiagnostic {
  readonly mode: ExecutionMode;
  readonly backend: "host" | "bubblewrap" | "seatbelt";
  readonly policyId: string;
  readonly executionStarted: boolean;
  readonly failure?: ExecutionFailureCode;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly stdout?: string;
  readonly stderr?: string;
}
