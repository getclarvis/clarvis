import type { BackendCapabilities } from "./diagnostics.ts";
import type { ExecutionPolicy } from "./policy.ts";

/** An argv vector that the caller may launch without shell interpretation. */
export interface LaunchSpec {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly backend: "host" | "bubblewrap" | "seatbelt";
  readonly policyId: string;
}

/** Platform backend for wrapping one complete child process. */
export interface SandboxBackend {
  readonly name: "bubblewrap" | "seatbelt";
  readonly capabilities: BackendCapabilities;
  prepare(
    policy: ExecutionPolicy,
    child: {
      file: string;
      args: readonly string[];
      cwd: string;
      env: Readonly<Record<string, string>>;
    },
  ): LaunchSpec;
}
