import type { LaunchSpec, SandboxBackend } from "./backend.ts";
import { SandboxSetupError } from "./diagnostics.ts";
import { assertExecutionPolicy, InvalidExecutionPolicy, type ExecutionPolicy } from "./policy.ts";

/** Produce a launch specification and report the actual chosen boundary. */
export function prepareLaunch(
  policy: ExecutionPolicy,
  child: {
    file: string;
    args: readonly string[];
    cwd: string;
    env: Readonly<Record<string, string>>;
  },
  backend?: SandboxBackend,
): LaunchSpec {
  assertExecutionPolicy(policy);
  if (policy.mode === "host") {
    return { ...child, backend: "host", policyId: policy.id };
  }
  if (policy.mode !== "sandbox") throw new InvalidExecutionPolicy("invalid execution mode");
  if (!backend) throw new InvalidExecutionPolicy("sandbox backend is required");
  try {
    return backend.prepare(policy, child);
  } catch (error) {
    if (error instanceof SandboxSetupError) throw error.withBoundary(backend.name, policy.id);
    throw error;
  }
}
