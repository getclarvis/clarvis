/**
 * A {@link MemoryProvider} that answers out of a tool server the host already
 * knows how to reach.
 *
 * The case that motivated the whole mechanism: an organisation with a knowledge
 * base behind an API, and no appetite for a second copy of it inside a
 * workspace. Nothing is loaded into this process, and nothing here knows what
 * the transport is.
 *
 * @remarks **This module names no MCP type and imports no MCP package.** It
 * declares the narrow port it consumes — {@link MemoryServerPort} — and the host
 * satisfies it structurally, exactly as the engine declares `TaskTrackingPort`
 * and never names the package that provides it. That is what keeps
 * `@clarvis/memory` from acquiring a dependency on `@clarvis/mcp-client` for the
 * sake of one provider kind.
 */
import { NOOP_LOGGER, sanitizeErrorMessage, type Logger } from "@clarvis/capability";

import {
  assertProviderVocabulary,
  MEMORY_READ_TOOL_NAMES,
  MEMORY_WRITE_TOOL_NAMES,
  type MemoryProvider,
} from "./provider.ts";
import {
  MEMORY_TOOL_CONTRACTS,
  memoryToolParameters,
  type MemoryToolName,
} from "./tool-contract.ts";
import type { MemoryToolDef, MemoryToolResult } from "./types.ts";

/** The `kind` discriminator this provider answers to in `memory.provider`. */
export const MCP_PROVIDER_KIND = "mcp";

/**
 * The one thing this provider needs from its host: the ability to call a named
 * tool on a named server.
 *
 * @remarks Deliberately smaller than any real client surface. No connect, no
 * close, no listing — the host owns the connection's whole lifecycle, and a
 * provider that could open or close one would be reaching past the seam.
 */
export interface MemoryServerPort {
  callTool(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ text: string; isError: boolean }>;
}

/**
 * Binds the host's tool-server seam to one authenticated owner.
 *
 * @remarks Binding happens while the provider is resolved, before any model
 *   tool exists. A provider therefore cannot choose, omit, or mutate the owner
 *   later when it forwards a call.
 */
export interface MemoryServerPortResolver {
  forOwner(owner: string): MemoryServerPort;
}

/**
 * Which server tool answers each Clarvis operation.
 *
 * @remarks A mapping rather than a naming convention, because a knowledge base
 * that predates this tool will not happen to spell its operations the way we
 * do — and renaming *our* side to match theirs is precisely what the invariant
 * forbids.
 */
export interface McpToolMapping {
  list_memories: string;
  read_memory: string;
  grep_memories: string;
  query_memories: string;
  write_memory?: string;
  edit_memory?: string;
  delete_memory?: string;
}

/** Construction inputs for {@link createMcpMemoryProvider}. */
export interface McpMemoryProviderOptions {
  /** Server name, as the host knows it. */
  server: string;
  /** Which server tool answers each operation. */
  tools: McpToolMapping;
  /**
   * Server tool that produces the entry block, when there is one.
   *
   * @remarks Optional: a server with no notion of a profile simply contributes
   * no block, and the run starts with the tools alone. That is a working
   * configuration, not a degraded one.
   */
  seedTool?: string;
  /** The host's call seam. */
  port: MemoryServerPort;
  /**
   * Where a seed the server did not produce is reported.
   *
   * @remarks A failed seed is indistinguishable from an empty one downstream —
   * both become `null`, and the run starts with an empty `<memory>` block. The
   * seed *body* is never logged, only the fact and the cause.
   */
  logger?: Logger;
}

/**
 * Build one tool def that forwards its call to the mapped server tool.
 *
 * @remarks The server's text comes back untouched. A provider answers in
 * whatever prose its own store speaks, and reshaping it here would be this
 * contract deciding what someone else's memory looks like.
 */
function toolFor(
  name: MemoryToolName,
  remote: string,
  opts: Pick<McpMemoryProviderOptions, "server" | "port">,
): MemoryToolDef {
  return {
    name,
    description: MEMORY_TOOL_CONTRACTS[name].description,
    parameters: memoryToolParameters(name),
    async execute(args, signal): Promise<MemoryToolResult> {
      try {
        const res = await opts.port.callTool(opts.server, remote, args, signal);
        return { text: res.text, isError: res.isError };
      } catch (err) {
        return {
          text: `memory provider failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  };
}

/**
 * Whether the write half was declared in full.
 *
 * @remarks All three or none. A mapping naming `write_memory` but not
 * `delete_memory` would advertise a vocabulary the model cannot complete, and
 * "read required, write optional" means optional *as a set*.
 */
function writeHalfOf(tools: McpToolMapping): string[] | undefined {
  const mapped = MEMORY_WRITE_TOOL_NAMES.map((n) => tools[n]);
  if (mapped.every((t) => typeof t === "string" && t.length > 0)) return mapped as string[];
  return undefined;
}

/**
 * Build the server-backed provider.
 *
 * @param opts - the server, the operation mapping, the optional seed tool and
 *   the host's call seam.
 * @returns a {@link MemoryProvider} whose write half is present only when the
 *   mapping declared all three write operations.
 * @throws {@link Error} when a partial write half was declared — a
 *   half-declared vocabulary is a configuration mistake worth failing on rather
 *   than silently narrowing.
 */
export function createMcpMemoryProvider(opts: McpMemoryProviderOptions): MemoryProvider {
  const declaredWrites = MEMORY_WRITE_TOOL_NAMES.filter((n) => (opts.tools[n] ?? "").length > 0);
  if (declaredWrites.length > 0 && declaredWrites.length < MEMORY_WRITE_TOOL_NAMES.length) {
    throw new Error(
      `memory provider 'mcp' declares a partial write half (${declaredWrites.join(", ")}): ` +
        `map all of [${MEMORY_WRITE_TOOL_NAMES.join(", ")}] or none of them`,
    );
  }

  const logger = opts.logger ?? NOOP_LOGGER;
  const seedFailed = (cause: string): void => {
    logger.warn(
      { event: "memory.seed.provider_failed", provider: MCP_PROVIDER_KIND, cause },
      "the memory provider did not produce a seed block; the run starts as though this workspace had learned nothing",
    );
  };
  const writes = writeHalfOf(opts.tools);
  const provider: MemoryProvider = {
    kind: MCP_PROVIDER_KIND,
    readTools: MEMORY_READ_TOOL_NAMES.map((n) => toolFor(n, opts.tools[n], opts)),
    ...(writes !== undefined
      ? {
          writeTools: MEMORY_WRITE_TOOL_NAMES.map((n, i) => toolFor(n, writes[i]!, opts)),
        }
      : {}),
    async seed(task?: string): Promise<string | null> {
      if (opts.seedTool === undefined) return null;
      let body: string;
      try {
        const res = await opts.port.callTool(opts.server, opts.seedTool, { task: task ?? "" });
        if (res.isError) {
          seedFailed("the seed tool answered with an error result");
          return null;
        }
        body = res.text.trim();
      } catch (err) {
        seedFailed(sanitizeErrorMessage(err instanceof Error ? err.message : String(err)));
        return null;
      }
      if (body.length === 0) return null;
      return body;
    },
  };
  assertProviderVocabulary(provider);
  return provider;
}
