/** Host-issued policy fields used by tools; the host owns construction and validation. */
export interface ToolIsolationPolicy {
  readonly id: string;
  readonly mode: "host" | "sandbox";
  readonly workspaceRoot: string;
  readonly workspaceAccess: "read-only" | "read-write";
  readonly network: "enabled" | "disabled";
  readonly homeRoot: string;
  readonly globalRoot: string;
  readonly globalAgentsRoot: string;
  readonly workflowsRoot: string;
  readonly settingsFile: string;
  readonly installationRoots: readonly string[];
  readonly temporaryWriteRoots: readonly string[];
  readonly denies: readonly string[];
}

export interface ToolLaunchSpec {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly backend: "host" | "bubblewrap" | "seatbelt";
  readonly policyId: string;
}

/** Native launcher supplied by the kernel; tools does not import a backend package. */
export interface ToolIsolationBackend {
  readonly name: "bubblewrap" | "seatbelt";
  prepare(
    policy: ToolIsolationPolicy,
    child: {
      file: string;
      args: readonly string[];
      cwd: string;
      env: Readonly<Record<string, string>>;
    },
  ): ToolLaunchSpec;
}

export interface ToolExecutionDiagnostic {
  readonly mode: "host" | "sandbox";
  readonly backend: "host" | "bubblewrap" | "seatbelt";
  readonly policyId: string;
  readonly executionStarted: boolean;
  readonly failure?:
    | "sandbox_unavailable"
    | "sandbox_setup_failed"
    | "sandbox_denied"
    | "command_failed"
    | "aborted"
    | "outcome_unknown";
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly stdout?: string;
  readonly stderr?: string;
}

/** Normalize a prelaunch failure without depending on its backend's Error class. */
export class ToolIsolationSetupError extends Error {
  readonly executionStarted = false;
  constructor(
    readonly code: "sandbox_unavailable" | "sandbox_setup_failed",
    message: string,
    readonly boundary?: { readonly backend: "bubblewrap" | "seatbelt"; readonly policyId: string },
  ) {
    super(message);
    this.name = "ToolIsolationSetupError";
  }
}

export function isIsolationSetupError(error: unknown): error is ToolIsolationSetupError {
  if (!(error instanceof Error)) return false;
  const candidate = error as Partial<ToolIsolationSetupError>;
  return (
    (candidate.code === "sandbox_unavailable" || candidate.code === "sandbox_setup_failed") &&
    candidate.executionStarted === false
  );
}
