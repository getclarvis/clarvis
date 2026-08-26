/**
 * A read-only {@link MemoryProvider} over a fixed set of workspace files.
 *
 * The cheapest real provider, and the one that covers doctrine: a project
 * constitution, a standing-rules document, a folder of notes another tool
 * maintains. It has no write half, so nothing here ever mutates the workspace
 * and no post-run indexing is scheduled — a document someone else authors is
 * not something a run should be quietly editing.
 */
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { assertProviderVocabulary, type MemoryProvider } from "./provider.ts";
import { MEMORY_TOOL_CONTRACTS, memoryToolParameters } from "./tool-contract.ts";
import { MEMORY_STORAGE_LIMITS } from "./storage-limits.ts";
import type { MemoryToolDef, MemoryToolResult } from "./types.ts";
import { createGrepScanner, grepHitText } from "./text/grep.ts";

/** The `kind` discriminator this provider answers to in `memory.provider`. */
export const FILE_PROVIDER_KIND = "file";

/** Construction inputs for {@link createFileMemoryProvider}. */
export interface FileMemoryProviderOptions {
  /** Absolute workspace root every declared path is resolved against. */
  workspaceRoot: string;
  /** Workspace-relative paths, in the order they are concatenated. */
  paths: readonly string[];
  maxPaths?: number;
  maxDocumentBytes?: number;
  maxAggregateBytes?: number;
}

const FILE_MEMORY_DEFAULT_LIMITS = {
  maxPaths: 64,
  maxDocumentBytes: 1024 * 1024,
  maxAggregateBytes: 8 * 1024 * 1024,
} as const;

function providerLimit(
  name: string,
  value: number | undefined,
  fallback: number,
  hardMaximum: number,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0 || resolved > hardMaximum) {
    throw new Error(
      `file memory provider ${name} must be an integer from 0 to ${String(hardMaximum)}`,
    );
  }
  return resolved;
}

/** A document that was asked for, and what reading it produced. */
interface LoadedDoc {
  /** The path as declared, always workspace-relative and POSIX-ish. */
  path: string;
  /** File content, or `null` when it does not exist or could not be read. */
  content: string | null;
  truncated?: boolean;
}

/**
 * Resolve a declared path inside the workspace.
 *
 * @param workspaceRoot - absolute workspace root.
 * @param declared - the path as written in settings.
 * @returns the absolute path, or `null` when it escapes the workspace.
 * @remarks Confinement is applied to *every* declarer, not only to plugins.
 *   An operator's own `settings.json` is trusted, but the same file is also
 *   what a plugin contributes into, and a rule that holds only for some callers
 *   is a rule nobody can reason about at the call site.
 */
function confine(workspaceRoot: string, declared: string): string | null {
  if (isAbsolute(declared)) return null;
  const abs = resolve(workspaceRoot, declared);
  const rel = relative(workspaceRoot, abs);
  if (rel.startsWith("..") || rel.startsWith(`${sep}..`) || isAbsolute(rel)) return null;
  return abs;
}

/**
 * Read every declared document, tolerating absence.
 *
 * @remarks A missing file is `content: null` rather than a throw: doctrine that
 * has not been written yet is a normal state, and the failure posture for a
 * provider is to answer poorly rather than to fail the run.
 */
async function readBounded(file: string, maxBytes: number): Promise<LoadedDoc["content"]> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) return null;
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function loadAll(
  opts: FileMemoryProviderOptions,
  selected = opts.paths,
): Promise<{ docs: LoadedDoc[]; truncated: boolean }> {
  const workspaceReal = await realpath(opts.workspaceRoot).catch(() => resolve(opts.workspaceRoot));
  const maxDocumentBytes = providerLimit(
    "maxDocumentBytes",
    opts.maxDocumentBytes,
    FILE_MEMORY_DEFAULT_LIMITS.maxDocumentBytes,
    MEMORY_STORAGE_LIMITS.documentBytes,
  );
  const maxAggregateBytes = providerLimit(
    "maxAggregateBytes",
    opts.maxAggregateBytes,
    FILE_MEMORY_DEFAULT_LIMITS.maxAggregateBytes,
    MEMORY_STORAGE_LIMITS.corpusBytes,
  );
  const docs: LoadedDoc[] = [];
  let aggregate = 0;
  let truncated = false;
  for (const path of selected) {
    const abs = confine(opts.workspaceRoot, path);
    if (abs === null) {
      docs.push({ path, content: null });
      continue;
    }
    try {
      const targetReal = await realpath(abs);
      const targetRel = relative(workspaceReal, targetReal);
      if (targetRel === ".." || targetRel.startsWith(`..${sep}`) || isAbsolute(targetRel)) {
        docs.push({ path, content: null });
        continue;
      }
      const size = (await stat(targetReal)).size;
      if (size > maxDocumentBytes || aggregate + size > maxAggregateBytes) {
        docs.push({ path, content: null, truncated: true });
        truncated = true;
        continue;
      }
      const content = await readBounded(targetReal, maxDocumentBytes);
      if (content === null) {
        docs.push({ path, content: null, truncated: true });
        truncated = true;
        continue;
      }
      const contentBytes = Buffer.byteLength(content, "utf8");
      if (aggregate + contentBytes > maxAggregateBytes) {
        docs.push({ path, content: null, truncated: true });
        truncated = true;
        continue;
      }
      aggregate += contentBytes;
      docs.push({ path, content });
    } catch {
      docs.push({ path, content: null });
    }
  }
  return { docs, truncated };
}

/** A successful tool result. */
const ok = (text: string): MemoryToolResult => ({ text, isError: false });

/** A failed tool result. */
const fail = (text: string): MemoryToolResult => ({ text, isError: true });

/**
 * Build the read-only file provider.
 *
 * @param opts - workspace root, declared paths and the seed cap.
 * @returns a {@link MemoryProvider} with the four read tools and no write half.
 * @remarks Every call re-reads from disk. Deliberate: these documents are
 *   authored by a human or another tool while a run is in flight, and a cached
 *   copy would answer with what was true at run start. The files are small and
 *   the read budget is already bounded by the toolset's call limit.
 */
export function createFileMemoryProvider(opts: FileMemoryProviderOptions): MemoryProvider {
  const maxPaths = providerLimit(
    "maxPaths",
    opts.maxPaths,
    FILE_MEMORY_DEFAULT_LIMITS.maxPaths,
    MEMORY_STORAGE_LIMITS.scanEntries,
  );
  // Validate every allocation-related option at construction rather than on
  // the first tool call, where an invalid plugin setting would be harder to
  // attribute.
  providerLimit(
    "maxDocumentBytes",
    opts.maxDocumentBytes,
    FILE_MEMORY_DEFAULT_LIMITS.maxDocumentBytes,
    MEMORY_STORAGE_LIMITS.documentBytes,
  );
  providerLimit(
    "maxAggregateBytes",
    opts.maxAggregateBytes,
    FILE_MEMORY_DEFAULT_LIMITS.maxAggregateBytes,
    MEMORY_STORAGE_LIMITS.corpusBytes,
  );
  if (opts.paths.length > maxPaths) {
    throw new Error(
      `file memory provider declares ${String(opts.paths.length)} paths, exceeding the ${String(maxPaths)}-path limit`,
    );
  }
  const declared = new Set(opts.paths);
  const listTool: MemoryToolDef = {
    name: "list_memories",
    description: MEMORY_TOOL_CONTRACTS.list_memories.description,
    parameters: memoryToolParameters("list_memories"),
    async execute(args) {
      const { docs, truncated } = await loadAll(opts);
      const prefix = typeof args.prefix === "string" ? args.prefix : "";
      const lines = docs
        .filter((doc) => doc.path.startsWith(prefix))
        .map(
          (d) =>
            `- ${d.path}${d.content === null ? " (not present)" : ` (${d.content.length} chars)`}`,
        );
      return ok(
        `${lines.join("\n")}${truncated ? "\n[listing incomplete: provider byte budget reached]" : ""}`,
      );
    },
  };

  const readTool: MemoryToolDef = {
    name: "read_memory",
    description: MEMORY_TOOL_CONTRACTS.read_memory.description,
    parameters: memoryToolParameters("read_memory"),
    async execute(args) {
      const paths = Array.isArray(args.paths)
        ? args.paths.filter((path): path is string => typeof path === "string")
        : [];
      if (paths.length === 0) return fail("read_memory needs at least one path");
      const selected = paths.filter((path) => declared.has(path));
      const { docs, truncated } = await loadAll(opts, selected);
      return ok(
        paths
          .map((path) => {
            const doc = docs.find((candidate) => candidate.path === path);
            return doc?.content === undefined || doc.content === null
              ? `## ${path}\n(not found)`
              : `## ${path}\n${doc.content}`;
          })
          .join("\n\n---\n\n") +
          (truncated ? "\n\n[read incomplete: provider byte budget reached]" : ""),
      );
    },
  };

  const grepTool: MemoryToolDef = {
    name: "grep_memories",
    description: MEMORY_TOOL_CONTRACTS.grep_memories.description,
    parameters: memoryToolParameters("grep_memories"),
    async execute(args) {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (query.length === 0) return fail("grep_memories needs a non-empty 'query'");
      const { docs, truncated } = await loadAll(opts);
      const hits: string[] = [];
      const limit = typeof args.limit === "number" ? args.limit : 20;
      const scanner = createGrepScanner(query, { regex: args.regex === true });
      outer: for (const doc of docs) {
        if (!scanner.ok()) break;
        if (doc.content === null) continue;
        const lines = doc.content.split("\n");
        for (let i = 0; i < lines.length; i += 1) {
          if (!scanner.ok() || hits.length >= limit) break outer;
          const line = lines[i] ?? "";
          if (scanner.match(line)) hits.push(`${doc.path}:${String(i + 1)}: ${grepHitText(line)}`);
        }
      }
      const text = hits.length === 0 ? "no matches" : hits.join("\n");
      return ok(`${text}${truncated ? "\n[search incomplete: provider byte budget reached]" : ""}`);
    },
  };

  const queryTool: MemoryToolDef = {
    name: "query_memories",
    description: MEMORY_TOOL_CONTRACTS.query_memories.description,
    parameters: memoryToolParameters("query_memories"),
    async execute(args) {
      const terms = (typeof args.query === "string" ? args.query : "")
        .toLowerCase()
        .split(/\W+/)
        .filter((t) => t.length > 2);
      const { docs, truncated } = await loadAll(opts);
      const prefix = typeof args.prefix === "string" ? args.prefix : "";
      const limit = typeof args.limit === "number" ? args.limit : 5;
      const scored = docs
        .filter(
          (d): d is LoadedDoc & { content: string } =>
            d.content !== null && d.path.startsWith(prefix),
        )
        .map((d) => {
          const body = d.content.toLowerCase();
          return { doc: d, score: terms.filter((t) => body.includes(t)).length };
        })
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
      if (scored.length === 0) {
        return ok(
          `no relevant documents — read them directly with list_memories and read_memory${truncated ? "\n[query incomplete: provider byte budget reached]" : ""}`,
        );
      }
      return ok(
        scored.map((s) => `- ${s.doc.path} (matched ${String(s.score)} term(s))`).join("\n") +
          (truncated ? "\n[query incomplete: provider byte budget reached]" : ""),
      );
    },
  };

  const provider: MemoryProvider = {
    kind: FILE_PROVIDER_KIND,
    readTools: [listTool, readTool, grepTool, queryTool],
    async seed(): Promise<string | null> {
      const { docs, truncated } = await loadAll(opts);
      const present = docs.filter((d): d is LoadedDoc & { content: string } => d.content !== null);
      if (present.length === 0) return null;
      const body = present.map((d) => `## ${d.path}\n\n${d.content.trim()}`).join("\n\n");
      return truncated ? `${body}\n\n[seed incomplete: provider byte budget reached]` : body;
    },
  };
  assertProviderVocabulary(provider);
  return provider;
}
