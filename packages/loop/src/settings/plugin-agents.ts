import { opendirSync, type Dirent } from "node:fs";
import { join, relative, sep } from "node:path";
import type { ZodError } from "zod";
import { pluginManifestSchema, type PluginManifest } from "./plugin-schema.ts";
import { PLUGIN_RESOURCE_LIMITS, readBoundedPluginText } from "./plugin-resources.ts";

/** One agent markdown file discovered under a plugin's agents directory. */
export interface PluginAgentFile {
  /** Forward-slash relative path from the agents directory (e.g. `nested/agent.md`). */
  name: string;
  /** The file's raw UTF-8 contents. */
  content: string;
}

/** Atomic result of reading one plugin's complete agent surface. */
export type PluginAgentFilesResult =
  { ok: true; files: PluginAgentFile[] } | { ok: false; error: string };

/**
 * Enumerate a plugin's complete agent markdown surface within hard traversal and byte budgets.
 *
 * This is the single source of truth for the executable "agent surface" a plugin
 * contributes: both the mcp loader and the code UI feed the result to
 * plugin agent discovery, so every host sees the same file set and ordering. A missing `agents/`
 * directory is an empty successful surface. Any other read or resource failure rejects the whole
 * surface; callers must never execute a prefix returned before the failure.
 * Never fork this walk — a divergence would make a plugin approved in one host
 * read as `changed`/`unapproved` in the other.
 */
export function readPluginAgentFiles(agentsDir: string): PluginAgentFilesResult {
  const out: PluginAgentFile[] = [];
  let directories = 0;
  let entriesSeen = 0;
  let filesSeen = 0;
  let aggregateBytes = 0;
  let failure: string | undefined;

  const reject = (reason: string): void => {
    failure ??= `plugin agents rejected: ${reason}`;
  };

  const walk = (dir: string, depth: number, root: boolean): void => {
    if (failure !== undefined) return;
    directories += 1;
    if (directories > PLUGIN_RESOURCE_LIMITS.agentDirectories) {
      reject(
        `directory count exceeds the ${String(PLUGIN_RESOURCE_LIMITS.agentDirectories)}-directory resource limit`,
      );
      return;
    }

    let opened: ReturnType<typeof opendirSync>;
    try {
      opened = opendirSync(dir);
    } catch (error) {
      if (root && ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        return;
      }
      reject(`directory '${relative(agentsDir, dir) || "."}' could not be read`);
      return;
    }

    const entries: Dirent[] = [];
    try {
      for (;;) {
        const entry = opened.readSync();
        if (entry === null) break;
        entriesSeen += 1;
        if (entriesSeen > PLUGIN_RESOURCE_LIMITS.agentEntries) {
          reject(
            `entry count exceeds the ${String(PLUGIN_RESOURCE_LIMITS.agentEntries)}-entry resource limit`,
          );
          break;
        }
        entries.push(entry);
      }
    } catch (error) {
      if (root && ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        return;
      }
      if (failure === undefined) {
        reject(`directory '${relative(agentsDir, dir) || "."}' changed while it was read`);
      }
    } finally {
      try {
        opened.closeSync();
      } catch {
        /* A completed/lazily failed read may already have closed the directory handle. */
      }
    }
    if (failure !== undefined) return;

    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth >= PLUGIN_RESOURCE_LIMITS.agentDepth) {
          reject(
            `directory '${relative(agentsDir, full)}' exceeds the ${String(PLUGIN_RESOURCE_LIMITS.agentDepth)}-level depth resource limit`,
          );
          return;
        }
        walk(full, depth + 1, false);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        filesSeen += 1;
        if (filesSeen > PLUGIN_RESOURCE_LIMITS.agentFiles) {
          reject(
            `file count exceeds the ${String(PLUGIN_RESOURCE_LIMITS.agentFiles)}-file resource limit`,
          );
          return;
        }
        const name = relative(agentsDir, full).split(sep).join("/");
        const read = readBoundedPluginText(
          full,
          PLUGIN_RESOURCE_LIMITS.agentFileBytes,
          `plugin agent '${name}'`,
        );
        if (!read.ok) {
          reject(read.error);
          return;
        }
        aggregateBytes += read.bytes;
        if (aggregateBytes > PLUGIN_RESOURCE_LIMITS.agentAggregateBytes) {
          reject(
            `aggregate source exceeds the ${String(PLUGIN_RESOURCE_LIMITS.agentAggregateBytes)}-byte resource limit`,
          );
          return;
        }
        out.push({
          name,
          content: read.text,
        });
      }
      if (failure !== undefined) return;
    }
  };
  walk(agentsDir, 0, true);
  return failure === undefined ? { ok: true, files: out } : { ok: false, error: failure };
}

/**
 * The result of {@link parsePluginManifest}: `ok` with the validated manifest, or
 * a failure discriminated by `kind` — `"json"` (the text was not JSON, `error`
 * is the thrown parse error) or `"schema"` (valid JSON that failed the schema,
 * `error` is the {@link ZodError}).
 */
export type PluginManifestParse =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; kind: "json"; error: unknown }
  | { ok: false; kind: "resource"; error: Error }
  | { ok: false; kind: "schema"; error: ZodError };

/**
 * Parse raw `plugin.json` text into a validated manifest. Callers keep their own
 * file-read and error-reporting conventions; only the JSON parse + schema check
 * are shared, so every host validates a manifest the exact same way.
 */
export function parsePluginManifest(raw: string): PluginManifestParse {
  if (Buffer.byteLength(raw, "utf8") > PLUGIN_RESOURCE_LIMITS.manifestBytes) {
    return {
      ok: false,
      kind: "resource",
      error: new Error(
        `plugin manifest exceeds the ${String(PLUGIN_RESOURCE_LIMITS.manifestBytes)}-byte resource limit`,
      ),
    };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    return { ok: false, kind: "json", error };
  }
  const parsed = pluginManifestSchema.safeParse(json);
  if (!parsed.success) return { ok: false, kind: "schema", error: parsed.error };
  return { ok: true, manifest: parsed.data };
}
