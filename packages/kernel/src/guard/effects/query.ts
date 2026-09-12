import type { EffectAttestorDeps } from "./types.ts";

/** Read-only argv probes; failures and excessive responses invalidate the entire attestation. */
export async function query(
  deps: EffectAttestorDeps,
  cwd: string,
  command: string,
  args: readonly string[],
): Promise<string> {
  if (deps.runner === undefined || deps.guest) throw new Error("effect evidence unavailable");
  const result = await deps.runner.run({
    command,
    args,
    cwd,
    environment: deps.environment,
    timeoutMs: 3000,
    maxOutputBytes: 16384,
    signal: deps.signal,
  });
  if (result.exitCode !== 0 || Buffer.byteLength(result.stdout) > 16384)
    throw new Error("effect evidence unavailable");
  return result.stdout.trim();
}
