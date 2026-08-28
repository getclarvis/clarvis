import { createHash } from "node:crypto";
import { globalPaths, writeFileAtomicSync } from "@clarvis/paths";
import { readJsonFile, type PluginManifest } from "@clarvis/loop/host";
import type { PluginRef } from "@clarvis/protocol";
import { z } from "zod";

const pluginRefSchema = z
  .object({
    scope: z.enum(["global", "workspace"]),
    source: z.enum(["agents", "clarvis"]),
    name: z.string().min(1),
  })
  .strict();
const hookApprovalSchema = z
  .object({
    plugin: pluginRefSchema,
    fingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    approved_at: z.string().min(1),
  })
  .strict();

const hookTrustSchema = z.object({ hooks: z.array(hookApprovalSchema) }).strict();
type HookTrust = z.infer<typeof hookTrustSchema>;

interface HookTrustRead {
  trust?: HookTrust;
  error?: string;
}

export interface PluginHookReview {
  plugin: PluginRef;
  fingerprint: string;
  definition: NonNullable<PluginManifest["hooks"]>[number];
  approved: boolean;
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

export function hookFingerprint(hook: unknown): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonical(hook)))
    .digest("hex")}`;
}

function readHookTrust(globalDir: string): HookTrustRead {
  const result = readJsonFile(globalPaths(globalDir).hookTrustFile, hookTrustSchema);
  if (result.ok) return { trust: result.value };
  if (result.missing === true) return { trust: { hooks: [] } };
  return { error: result.error };
}

export function pluginHookReviews(
  globalDir: string,
  plugin: PluginRef,
  hooks: NonNullable<PluginManifest["hooks"]> = [],
): PluginHookReview[] {
  const trust = readHookTrust(globalDir).trust ?? { hooks: [] };
  return hooks.map((definition) => {
    const fingerprint = hookFingerprint(definition);
    return {
      plugin,
      fingerprint,
      definition,
      approved: trust.hooks.some(
        (entry) =>
          entry.plugin.scope === plugin.scope &&
          entry.plugin.source === plugin.source &&
          entry.plugin.name === plugin.name &&
          entry.fingerprint === fingerprint,
      ),
    };
  });
}

export function writeHookApproval(
  globalDir: string,
  plugin: PluginRef,
  fingerprint: string,
  approved: boolean,
): void {
  const current = readHookTrust(globalDir);
  if (current.trust === undefined) {
    throw new Error(`hook-trust.json is unreadable, refusing to overwrite: ${current.error}`);
  }
  const without = current.trust.hooks.filter(
    (entry) =>
      !(
        entry.plugin.scope === plugin.scope &&
        entry.plugin.source === plugin.source &&
        entry.plugin.name === plugin.name &&
        entry.fingerprint === fingerprint
      ),
  );
  const hooks = approved
    ? [...without, { plugin, fingerprint, approved_at: new Date().toISOString() }]
    : without;
  writeFileAtomicSync(
    globalPaths(globalDir).hookTrustFile,
    `${JSON.stringify({ hooks }, null, 2)}\n`,
  );
}
