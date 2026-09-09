import type { ConfigStore } from "../config/config-store.ts";
import { kernelError } from "../core/errors.ts";

/** Read-only inputs shared by the root assembler and every later workflow leader. */
export type RunConfigurationSource = Pick<
  ConfigStore,
  "readSettings" | "readContext" | "readEffectiveAgent" | "listAgents"
>;

/**
 * Capture the effective, trust-filtered configuration for one admitted tree. Returned values are
 * independent copies because workflow assembly removes grants from the body it receives. This
 * snapshot contains neither a writable store nor subscription credentials and is never serialized
 * into the hosted discovery index. Live guard and extension revocation remain host-owned.
 */
export function snapshotRunConfiguration(source: RunConfigurationSource): RunConfigurationSource {
  const settings = source.readSettings();
  const names = [...new Set(source.listAgents().map((agent) => agent.name))];
  if (names.length > 1024)
    throw kernelError("resource_exhausted", "run configuration exceeds 1024 agent profiles");
  const records = names.flatMap((name) => {
    const record = source.readEffectiveAgent(name);
    return record === null ? [] : [record];
  });
  const contexts = {
    global: source.readContext("global"),
    workspace: source.readContext("workspace"),
  };
  const encoded = JSON.stringify({ settings, records, contexts });
  if (Buffer.byteLength(encoded) > 16 * 1024 * 1024)
    throw kernelError("resource_exhausted", "run configuration exceeds 16 MiB");
  const captured = structuredClone({ settings, records, contexts });
  const byName = new Map(captured.records.map((record) => [record.name, record]));
  return {
    readSettings: () => structuredClone(captured.settings),
    readContext: (scope) => structuredClone(captured.contexts[scope]),
    listAgents: () => structuredClone(captured.records),
    readEffectiveAgent: (name) => structuredClone(byName.get(name) ?? null),
  };
}
