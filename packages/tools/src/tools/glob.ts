import { promises as fs } from "node:fs";
import { ToolError } from "../errors.ts";
import { resolvePath, displayPath } from "../lib/paths.ts";
import { listFiles, mapLimit, statDirectory, STAT_CONCURRENCY } from "../lib/files.ts";
import type { ToolDef } from "./types.ts";

type ListFiles = typeof listFiles;

/**
 * Build the `glob` tool: find files (never directories) matching a glob
 * pattern, returned one workspace-relative path per line, most-recently-modified
 * first.
 *
 * @param listFilesImpl - the file-enumeration backend, injectable for testing;
 *   defaults to {@link listFiles}.
 * @returns a {@link ToolDef} whose handler resolves `path` (default: workspace
 *   root), confirms it is a directory via {@link statDirectory}, enumerates
 *   matches, then stats each with bounded concurrency ({@link STAT_CONCURRENCY})
 *   to sort newest-first (ties broken by path). `respect_gitignore` defaults to
 *   true, skipping ignored files and `.git/`. No matches returns the single line
 *   `(no matches)` - a success, not an error.
 * @remarks An entry whose stat fails between enumeration and sorting is silently
 *   dropped. An invalid pattern surfaces as a {@link ToolError} with code
 *   `invalid_input`.
 */
export function createGlobTool(listFilesImpl: ListFiles = listFiles): ToolDef {
  return {
    name: "glob",
    description:
      "Find files (not directories) by glob pattern, returned one path per line, " +
      "most-recently-modified first. Use when you know part of a name or extension but not the full " +
      "path. To search file CONTENTS use grep instead. No matches returns the line `(no matches)` — " +
      "a success, not an error.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description:
            'Glob pattern, e.g. "**/*.ts" or "src/**/test_*.py". ** matches across directories.',
        },
        path: {
          type: "string",
          description:
            "Base directory for the search. Relative to workspace root or absolute. Default: " +
            "workspace root.",
        },
        respect_gitignore: {
          type: "boolean",
          default: true,
          description:
            "When true (default), skip files ignored by .gitignore and the .git/ directory.",
        },
      },
      required: ["pattern"],
    },
    async handler(args, config) {
      const pattern = args.pattern as string;
      const baseRel = (args.path as string | undefined) ?? ".";
      const base = resolvePath(
        baseRel,
        config.workspaceRoot,
        config.confineToWorkspace,
        config.temporaryRoots,
        config.logger,
      );
      const respectGitignore = args.respect_gitignore as boolean;

      await statDirectory(base, baseRel);

      let files: string[];
      let truncated: boolean;
      try {
        const listing = await listFilesImpl(base, config.workspaceRoot, {
          pattern,
          respectGitignore,
          maxEntries: config.maxTraversalEntries,
        });
        files = listing.files;
        truncated = listing.truncated;
      } catch (err) {
        throw new ToolError("invalid_input", `Invalid glob pattern: ${(err as Error).message}`, {
          pattern,
        });
      }

      const stats = await mapLimit(files, STAT_CONCURRENCY, async (abs) => {
        try {
          return { abs, mtime: (await fs.stat(abs)).mtimeMs };
        } catch {
          return null;
        }
      });
      const withMtime = stats
        .filter((s): s is { abs: string; mtime: number } => s !== null)
        .map((s) => ({ rel: displayPath(s.abs, config.workspaceRoot), mtime: s.mtime }));

      if (withMtime.length === 0) return "(no matches)";

      withMtime.sort((a, b) => b.mtime - a.mtime || (a.rel < b.rel ? -1 : 1));
      const rendered = withMtime.map((e) => e.rel).join("\n");
      return truncated
        ? `${rendered}\n[search incomplete: traversal stopped at ${String(config.maxTraversalEntries)} entries]`
        : rendered;
    },
  };
}

/**
 * The default `glob` tool instance, backed by the real {@link listFiles}. Prefer
 * {@link createGlobTool} when a test needs to inject a different enumerator.
 */
export const globTool: ToolDef = createGlobTool();
