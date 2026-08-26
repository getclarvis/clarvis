import { createHash } from "node:crypto";
import type { TASKS_PROTOCOL } from "./settings.ts";

export interface TaskProviderKeyMaterial {
  kind: "mcp";
  server: string;
  protocol: typeof TASKS_PROTOCOL;
  providerKind: string;
  providerInstanceId: string;
  declaration: unknown;
  plugin?: {
    name: string;
    version?: string;
    revision?: string;
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    const child = record[key];
    if (child !== undefined) out[key] = canonical(child);
  }
  return out;
}

/** Stable provider identity over a host-supplied, already secret-free declaration. */
export function taskProviderKey(material: TaskProviderKeyMaterial): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(canonical(material)))
    .digest("hex");
  return `tasks:mcp:v2:sha256:${digest}`;
}
