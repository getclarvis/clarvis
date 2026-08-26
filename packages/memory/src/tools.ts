/**
 * Wiki tools: read/list/grep to navigate the memory tree, write/edit/delete to
 * maintain it. The agent uses these in-run (it may write memory directly, no
 * approval gate) and they are the same tools a host exposes to the owner over a
 * kernel/MCP surface. Host-agnostic: the host adapts MemoryToolDef to its own
 * tool shape. Every write/edit/delete triggers a deterministic reindex so the
 * navigation link blocks stay in sync.
 */
import { z } from "zod";

import { reindexView } from "./batch.ts";
import { parseFrontmatter, readDescription } from "./frontmatter.ts";
import { checkWrite, type MemoryWriteIntent } from "./policy.ts";
import { queryMemory } from "./query.ts";
import type { MemoryRevisionSource } from "./revisions.ts";
import { sanitizeText } from "@clarvis/capability";
import { truncate } from "./text.ts";
import { MEMORY_STORAGE_LIMITS } from "./storage-limits.ts";
import type {
  MemoryMutationFence,
  MemoryStore,
  MemoryToolDef,
  MemoryToolResult,
  MemoryTx,
  MemoryUnitOfWork,
} from "./types.ts";
import { MEMORY_TOOL_CONTRACTS } from "./tool-contract.ts";

const DESCRIPTION_MAX = 120;
const READ_MAX_CHARS = 8000;
const LOST_INDEX_CLAIM = "The memory index claim is no longer current; stale mutation refused.";

/**
 * Build a success {@link MemoryToolResult}, running {@link sanitizeText} over the
 * text so no secret reaches the model even when it was echoed from a document.
 *
 * @param text - Human-readable tool output.
 * @returns A result with `isError: false`.
 */
function ok(text: string): MemoryToolResult {
  return { text: sanitizeText(text), isError: false };
}

/**
 * Build a failure {@link MemoryToolResult}, sanitized like {@link ok}.
 *
 * @param text - Human-readable error message.
 * @returns A result with `isError: true`.
 * @remarks Tools report errors through this shape rather than throwing, so the
 * model always receives a well-formed result (see {@link MemoryToolDef.execute}).
 */
function fail(text: string): MemoryToolResult {
  return { text: sanitizeText(text), isError: true };
}

/**
 * Derive a tool's JSON Schema from the zod schema that actually validates it.
 *
 * @param schema - the tool's argument schema.
 * @returns a bare JSON Schema object: `$schema` stripped (hosts want the schema
 *   itself, not a document) and the object closed to unknown properties.
 * @remarks Deriving rather than hand-writing removes a drift point that no test
 *   could have caught — the advertised shape and the enforced shape are now the
 *   same declaration. Refinements are intentionally absent from the output:
 *   JSON Schema cannot express them, and zod still enforces every one inside
 *   {@link MemoryToolDef.execute}, so the model sees the coarse shape and gets a
 *   precise error when it violates the fine print.
 */
function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _document, ...rest } = z.toJSONSchema(schema, { io: "input" }) as Record<
    string,
    unknown
  >;
  return { ...rest, additionalProperties: false };
}

/**
 * Wrap a tool body so it validates its arguments and can never throw.
 *
 * @param def - The tool's name and description; `parameters` is derived from
 * `schema` rather than supplied.
 * @param schema - Zod schema the raw arguments are parsed against before `run`
 * sees them, and the source of the advertised `parameters`.
 * @param run - The tool's typed body, invoked only with validated `args`.
 * @returns A complete {@link MemoryToolDef} whose `execute` returns a
 * {@link fail} result on invalid arguments (reporting the first zod issue) or on
 * any thrown error, and otherwise the body's result.
 */
function tool<S extends z.ZodType>(
  def: Omit<MemoryToolDef, "execute" | "parameters">,
  schema: S,
  run: (args: z.infer<S>, signal?: AbortSignal) => Promise<MemoryToolResult>,
): MemoryToolDef {
  return {
    ...def,
    parameters: jsonSchemaOf(schema),
    async execute(args, signal) {
      const parsed = schema.safeParse(args);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        return fail(
          `Invalid arguments: ${first ? `${first.path.join(".") || "(root)"}: ${first.message}` : "unknown"}`,
        );
      }
      try {
        return await run(parsed.data, signal);
      } catch (err) {
        return fail(`Tool failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}

/** Collaborators {@link createMemoryTools} needs: the backing store and the
 * deterministic reindex it runs after each mutation. */
export interface CreateMemoryToolsArgs {
  store: MemoryStore;
  /** Deterministic link-block reindex, run inside each mutation's own batch.
   * Returns the paths it changed. */
  reindex: (tx: Pick<MemoryTx, "read" | "write" | "list">) => Promise<string[]>;
  /**
   * Provenance stamped on every revision these tools create.
   *
   * @remarks Defaults to `{ kind: "tool", tool: <wire name> }` — an agent
   * editing memory during its own run. The per-run indexer builds its own tool
   * array over the same store and passes `{ kind: "indexer", run_id }` instead,
   * so a revision still names the run it was learned from. Without it the
   * indexer's writes would be indistinguishable from a user-run edit, and the
   * `run_id` the memory panel labels a revision "run" from would be empty for
   * every document the indexer ever touched.
   */
  source?: MemoryRevisionSource;
  /**
   * Who {@link checkWrite} is told is asking. Defaults to `"agent_tool"`.
   *
   * @remarks `"indexer"` and `"agent_tool"` are treated identically by the write
   * policy — only `"owner"` and `"reindex"` bypass it — so this changes no
   * decision. It is carried because the diagnostics report the intent refused.
   */
  intent?: MemoryWriteIntent;
  /**
   * Optional queue-claim fence used by the background indexer.
   *
   * @remarks Ordinary run and control-plane tools omit it. When present, each
   *   mutating tool checks it immediately before and after its batch while the
   *   same {@link MemoryUnitOfWork} is held, so a reclaimed worker cannot write
   *   to the wiki between an independent lease check and the mutation.
   */
  mutationFence?: MemoryMutationFence;
}

/** Run one mutation between two claim checks on the same unit of work. */
async function fencedMutation<T>(
  tx: MemoryUnitOfWork,
  fence: MemoryMutationFence | undefined,
  mutate: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false }> {
  if (fence !== undefined && !(await fence.before(tx))) return { ok: false };
  try {
    const value = await mutate();
    if (fence !== undefined && !(await fence.after(tx))) return { ok: false };
    return { ok: true, value };
  } catch (error) {
    // A recoverable batch normally leaves no mutation behind when it throws,
    // but the post-check still runs: a backend fault must not leave the worker
    // believing its fence stayed current merely because its write also failed.
    if (fence !== undefined) await fence.after(tx);
    throw error;
  }
}

/**
 * Render the trailing `(reindexed: …)` note appended to a mutation's success
 * message.
 *
 * @param changed - Paths the reindex touched.
 * @returns A leading-newline note listing them, or the empty string when nothing
 * changed.
 */
function reindexNote(changed: string[]): string {
  if (changed.length === 0) return "";
  return `\n(reindexed: ${changed.join(", ")})`;
}

/**
 * Build the model-facing memory tools over a store: `list_memories`,
 * `query_memories`, `read_memory` and `grep_memories` to navigate, and
 * `write_memory`, `edit_memory`, `delete_memory` to maintain the tree.
 *
 * @param args - The backing {@link MemoryStore} and the {@link CreateMemoryToolsArgs.reindex} callback.
 * @returns The tool definitions, host-agnostic ({@link MemoryToolDef}), in the
 * order listed above.
 * @remarks Each mutating tool runs its body under {@link MemoryStore.exclusive} and
 * calls `reindex(tx)` on the same handle afterward, so navigation link blocks stay
 * in sync without a nested lock acquisition; the note is
 * appended via {@link reindexNote}. Path arguments are constrained by
 * `memoryWritablePathSchema` (write/edit) and `memoryLeafPathSchema` (delete), so
 * writes stay inside the tree and deletes hit only MEMORY leaves. `write_memory`
 * warns when the content carries no frontmatter `description:`, since the parent
 * index would then have nothing to list. `edit_memory` fails unless `old_string`
 * occurs exactly once. There is no approval gate — the agent writes memory
 * directly in-run — but all three mutating tools pass the change through
 * {@link checkWrite} at {@link CreateMemoryToolsArgs.intent} (`"agent_tool"` by
 * default), which is what keeps a run from
 * granting itself the owner-only `pinned`/`authority: confirmed` markers or
 * stripping a pin back off. `edit_memory` declares `operation: "edit"`, never
 * `"replace"`, so a surgical edit to a pinned document stays allowed.
 */
export function createMemoryTools(args: CreateMemoryToolsArgs): MemoryToolDef[] {
  const { store, reindex } = args;
  const intent: MemoryWriteIntent = args.intent ?? "agent_tool";
  const sourceFor = (tool: string): MemoryRevisionSource => args.source ?? { kind: "tool", tool };

  const listMemories = tool(
    {
      name: MEMORY_TOOL_CONTRACTS.list_memories.name,
      description: MEMORY_TOOL_CONTRACTS.list_memories.description,
    },
    MEMORY_TOOL_CONTRACTS.list_memories.schema,
    async (a) => {
      const docs = await store.list();
      const filtered = a.prefix ? docs.filter((d) => d.path.startsWith(a.prefix as string)) : docs;
      if (filtered.length === 0) {
        return ok(
          "No memory documents yet. Use write_memory to record the first durable learning.",
        );
      }
      return ok(
        filtered
          .map(
            (d) =>
              `${d.path} · ${d.kind}${d.description ? ` · ${truncate(d.description, DESCRIPTION_MAX)}` : ""}`,
          )
          .join("\n"),
      );
    },
  );

  const readMemory = tool(
    {
      name: MEMORY_TOOL_CONTRACTS.read_memory.name,
      description: MEMORY_TOOL_CONTRACTS.read_memory.description,
    },
    MEMORY_TOOL_CONTRACTS.read_memory.schema,
    async (a) => {
      const parts: string[] = [];
      for (const p of a.paths) {
        const bounded =
          store.readBounded === undefined
            ? null
            : await store.readBounded(
                p,
                Math.min(MEMORY_STORAGE_LIMITS.prefixBytes, READ_MAX_CHARS * 4),
              );
        const text = bounded === null ? await store.read(p) : bounded.text;
        parts.push(
          text === null
            ? `## ${p}\n(not found)`
            : `## ${p}\n${truncate(text, READ_MAX_CHARS)}` +
                (bounded?.truncated === true ? "\n[document truncated for display]" : ""),
        );
      }
      return ok(parts.join("\n\n---\n\n"));
    },
  );

  const grepMemories = tool(
    {
      name: MEMORY_TOOL_CONTRACTS.grep_memories.name,
      description: MEMORY_TOOL_CONTRACTS.grep_memories.description,
    },
    MEMORY_TOOL_CONTRACTS.grep_memories.schema,
    async (a) => {
      const hits = await store.grep(a.query, { limit: a.limit, regex: a.regex });
      if (hits.length === 0) return ok("No matches. Memory may simply not cover this yet.");
      return ok(hits.map((h) => `${h.path}:${h.line}: ${h.text}`).join("\n"));
    },
  );

  const queryMemories = tool(
    {
      name: MEMORY_TOOL_CONTRACTS.query_memories.name,
      description: MEMORY_TOOL_CONTRACTS.query_memories.description,
    },
    MEMORY_TOOL_CONTRACTS.query_memories.schema,
    async (a) => {
      const result = await queryMemory({
        tx: store,
        input: {
          query: a.query,
          limit: a.limit,
          ...(a.prefix !== undefined ? { prefix: a.prefix } : {}),
          ...(a.kinds !== undefined ? { kinds: a.kinds } : {}),
        },
      });
      if (result.terms.length === 0) {
        return ok("That query carried no searchable terms. Try naming the topic or a command.");
      }
      if (result.hits.length === 0) {
        return ok("No relevant documents. Memory may simply not cover this yet.");
      }
      const blocks = result.hits.map((hit) => {
        const head = `${hit.path} · ${hit.score.toFixed(2)} · ${hit.title}`;
        const desc = hit.description === "" ? "" : `\n${hit.description}`;
        const snippet = hit.snippet === "" ? "" : `\n${hit.snippet}`;
        return `${head}${desc}${snippet}`;
      });
      return ok(blocks.join("\n\n---\n\n"));
    },
  );

  const writeMemory = tool(
    {
      name: MEMORY_TOOL_CONTRACTS.write_memory.name,
      description: MEMORY_TOOL_CONTRACTS.write_memory.description,
    },
    MEMORY_TOOL_CONTRACTS.write_memory.schema,
    (a) =>
      store.exclusive(async (tx) => {
        const current = await tx.read(a.path);
        const decision = checkWrite({
          intent,
          operation: current === null ? "create" : "replace",
          existing: current === null ? null : parseFrontmatter(current).frontmatter,
          next: parseFrontmatter(a.content).frontmatter,
        });
        if (!decision.allowed) return fail(`${a.path}: ${decision.reason ?? "blocked"}`);
        const mutation = await fencedMutation(tx, args.mutationFence, () =>
          tx.batch({ source: sourceFor("write_memory") }, async (bx) => {
            await bx.write(a.path, a.content);
            return reindex(reindexView(bx));
          }),
        );
        if (!mutation.ok) return fail(LOST_INDEX_CLAIM);
        const changed = mutation.value;
        const warn =
          readDescription(a.content).trim() === ""
            ? "\nWarning: no `description:` in frontmatter — this document will not be described in its parent index."
            : "";
        return ok(`Wrote ${a.path}.${warn}${reindexNote(changed)}`);
      }),
  );

  const editMemory = tool(
    {
      name: MEMORY_TOOL_CONTRACTS.edit_memory.name,
      description: MEMORY_TOOL_CONTRACTS.edit_memory.description,
    },
    MEMORY_TOOL_CONTRACTS.edit_memory.schema,
    (a) =>
      store.exclusive(async (tx) => {
        const current = await tx.read(a.path);
        if (current === null) return fail(`${a.path}: not found`);
        const count = current.split(a.old_string).length - 1;
        if (count === 0) return fail(`old_string not found in ${a.path}`);
        if (count > 1) return fail(`old_string occurs ${count}× in ${a.path} — make it unique`);
        const edited = current.replace(a.old_string, a.new_string);
        const decision = checkWrite({
          intent,
          operation: "edit",
          existing: parseFrontmatter(current).frontmatter,
          next: parseFrontmatter(edited).frontmatter,
        });
        if (!decision.allowed) return fail(`${a.path}: ${decision.reason ?? "blocked"}`);
        const mutation = await fencedMutation(tx, args.mutationFence, () =>
          tx.batch({ source: sourceFor("edit_memory") }, async (bx) => {
            await bx.write(a.path, edited);
            return reindex(reindexView(bx));
          }),
        );
        if (!mutation.ok) return fail(LOST_INDEX_CLAIM);
        const changed = mutation.value;
        return ok(`Edited ${a.path}.${reindexNote(changed)}`);
      }),
  );

  const deleteMemory = tool(
    {
      name: MEMORY_TOOL_CONTRACTS.delete_memory.name,
      description: MEMORY_TOOL_CONTRACTS.delete_memory.description,
    },
    MEMORY_TOOL_CONTRACTS.delete_memory.schema,
    (a) =>
      store.exclusive(async (tx) => {
        const current = await tx.read(a.path);
        if (current === null) return fail(`${a.path}: not found`);
        const decision = checkWrite({
          intent,
          operation: "delete",
          existing: parseFrontmatter(current).frontmatter,
        });
        if (!decision.allowed) return fail(`${a.path}: ${decision.reason ?? "blocked"}`);
        const mutation = await fencedMutation(tx, args.mutationFence, () =>
          tx.batch({ source: sourceFor("delete_memory") }, async (bx) => {
            await bx.delete(a.path);
            return reindex(reindexView(bx));
          }),
        );
        if (!mutation.ok) return fail(LOST_INDEX_CLAIM);
        const changed = mutation.value;
        return ok(`Deleted ${a.path}.${reindexNote(changed)}`);
      }),
  );

  return [
    listMemories,
    queryMemories,
    readMemory,
    grepMemories,
    writeMemory,
    editMemory,
    deleteMemory,
  ];
}
