import { join } from "node:path";
import { PLUGIN_RESOURCE_LIMITS, readBoundedPluginText } from "@clarvis/loop/host";

/** Machinery sidecar written beside one installed plugin snapshot. */
export const PLUGIN_INSTALL_RECORD = "install-record.json";

export interface PluginInstallRecord {
  source?: string;
  revision?: string;
  subdir?: string;
}

/** Missing records identify unmanaged local plugins; present invalid records reject the plugin. */
export type PluginInstallRecordRead =
  { ok: true; record: PluginInstallRecord; present: boolean } | { ok: false; error: string };

/** Read and validate the bounded installation sidecar shared by UI and runtime discovery. */
export function readPluginInstallRecord(dir: string): PluginInstallRecordRead {
  const read = readBoundedPluginText(
    join(dir, PLUGIN_INSTALL_RECORD),
    PLUGIN_RESOURCE_LIMITS.installRecordBytes,
    `plugin install record '${PLUGIN_INSTALL_RECORD}'`,
  );
  if (!read.ok) {
    return read.missing
      ? { ok: true, record: {}, present: false }
      : { ok: false, error: read.error };
  }

  let value: unknown;
  try {
    value = JSON.parse(read.text);
  } catch (error) {
    return {
      ok: false,
      error: `plugin install record '${PLUGIN_INSTALL_RECORD}' is not valid JSON: ${(error as Error).message}`,
    };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      ok: false,
      error: `plugin install record '${PLUGIN_INSTALL_RECORD}' must be an object`,
    };
  }

  const source = value as Record<string, unknown>;
  for (const field of ["source", "revision", "subdir"] as const) {
    if (source[field] !== undefined && typeof source[field] !== "string") {
      return {
        ok: false,
        error: `plugin install record '${PLUGIN_INSTALL_RECORD}' field '${field}' must be a string`,
      };
    }
  }
  return {
    ok: true,
    present: true,
    record: {
      ...(typeof source.source === "string" ? { source: source.source } : {}),
      ...(typeof source.revision === "string" ? { revision: source.revision } : {}),
      ...(typeof source.subdir === "string" ? { subdir: source.subdir } : {}),
    },
  };
}
