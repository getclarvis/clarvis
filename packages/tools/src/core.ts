import { createRequire } from "node:module";
import type { ValidateFunction } from "ajv";
import { ToolError, serializeError } from "./errors.ts";
import { bound } from "./lib/output.ts";
import { tools, getTool, selectSurface } from "./tools/registry.ts";
import { textPart, type ContentPart, type ToolResult } from "./tools/content.ts";
import type { ToolCallHooks } from "./tools/types.ts";
import { buildGuardContext } from "./guard/context.ts";
import type { ElicitRequest, GuardReview } from "./guard/types.ts";
import type { RuntimeConfig } from "./config.ts";
import { assertOutsideRoots } from "./lib/paths.ts";

const NATIVE_MUTATION_TOOLS = new Set([
  "write_file",
  "edit_file",
  "multi_edit",
  "apply_patch",
  "replace",
  "move",
  "copy",
  "mkdir",
  "remove",
]);

/** Refuse native mutations below host-selected skill directories before guard or handler work. */
function protectSkillPackages(
  name: string,
  args: Record<string, unknown>,
  config: RuntimeConfig,
): void {
  if (!NATIVE_MUTATION_TOOLS.has(name) || config.skillExecutionRoots.length === 0) return;
  const context = buildGuardContext(name, args, config);
  for (const fact of context.paths) {
    assertOutsideRoots(fact.resolved, config.skillExecutionRoots, fact.raw);
  }
}

interface AjvInstance {
  compile(schema: unknown): ValidateFunction;
  errorsText(errors?: unknown, opts?: { separator?: string }): string;
}

interface AjvModule {
  default: new (opts?: Record<string, unknown>) => AjvInstance;
}

const Ajv = (createRequire(import.meta.url)("ajv") as AjvModule).default;

const ajv = new Ajv({ allErrors: true, useDefaults: true, coerceTypes: true });
const validators = new Map<string, ValidateFunction>();
for (const tool of tools) {
  validators.set(tool.name, ajv.compile(tool.inputSchema));
}

/**
 * The outcome of a single tool call: whether it failed, the content parts to
 * return, and any tool-supplied metadata. An error is reported in-band (as
 * `isError: true` with a serialized error text part), not by throwing.
 */
export interface DispatchResult {
  /** True when the call failed; `content` then holds the serialized error. */
  isError: boolean;
  /** The tool's output as text/image content parts. */
  content: ContentPart[];
  /** Optional structured metadata a tool attaches to a successful result. */
  meta?: Record<string, unknown>;
  /** Final command-review outcome, when the host guard exposes its mode. */
  guard?: GuardReview;
}

function normalizeOutput(out: string | ToolResult): ToolResult {
  return typeof out === "string" ? { content: out } : out;
}

function errorResult(err: unknown): DispatchResult {
  return { isError: true, content: [textPart(serializeError(err))] };
}

function boundParts(
  parts: ContentPart[],
  bounded: boolean | undefined,
  maxOutputBytes: number,
): ContentPart[] {
  if (bounded) return parts;
  return parts.map((p) => (p.type === "text" ? textPart(bound(p.text, maxOutputBytes)) : p));
}

function boundMeta(meta: Record<string, unknown>, maxBytes: number): Record<string, unknown> {
  const encoded = JSON.stringify(meta);
  if (Buffer.byteLength(encoded, "utf8") <= maxBytes) return meta;
  const base = {
    truncated: true,
    truncation_reason: `tool metadata exceeded ${String(maxBytes)} bytes`,
  };
  const diff = typeof meta.diff === "string" ? meta.diff : undefined;
  if (diff === undefined) return base;

  const suffix = "\n[diff truncated to metadata budget]";
  let low = 0;
  let high = diff.length;
  let best: Record<string, unknown> = base;
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const candidate = { diff: `${diff.slice(0, midpoint)}${suffix}`, ...base };
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= maxBytes) {
      best = candidate;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }
  return best;
}

/**
 * The public description of a tool as advertised to a client/model: its name,
 * description, and argument schema, without the handler.
 */
export interface ToolInfo {
  /** The tool's dispatch name. */
  name: string;
  /** The human-readable description shown to the model. */
  description: string;
  /** The JSON Schema for the tool's arguments. */
  inputSchema: Record<string, unknown>;
}

/**
 * List the tools available under a given config.
 *
 * @param config - the resolved server config; its `readOnly` flag selects the
 *   surface.
 * @returns the advertised {@link ToolInfo} for each tool in the effective
 *   surface (see {@link selectSurface}).
 */
export function listTools(config: RuntimeConfig): ToolInfo[] {
  return selectSurface(config.readOnly).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

/**
 * Run the command-approval gate for one call.
 *
 * @returns The gate's optional denial plus its final review metadata. A `deny`
 *   verdict, or an `ask` with no elicit prompt or a rejected prompt, all deny.
 *   A throw inside the guard/elicit is caught and returned as an error result.
 */
interface GuardGate {
  denied?: DispatchResult;
  review?: GuardReview;
}

async function applyGuard(
  name: string,
  args: Record<string, unknown>,
  config: RuntimeConfig,
): Promise<GuardGate> {
  if (!config.guard) {
    return name === "host_vcs"
      ? { denied: errorResult(new ToolError("denied", "host_vcs requires command review")) }
      : {};
  }
  try {
    const ctx = buildGuardContext(name, args, config);
    const decision = await config.guard(ctx);
    const review = (
      outcome: GuardReview["outcome"],
      answerer: GuardReview["answerer"],
    ): GuardReview | undefined =>
      decision.mode === undefined ? undefined : { mode: decision.mode, outcome, answerer };
    if (decision.verdict === "allow") return { review: review("allowed", "policy") };
    const reason = decision.reason ?? "blocked by guard";
    if (decision.verdict === "deny")
      return {
        denied: errorResult(new ToolError("denied", reason)),
        review: review("denied", "policy"),
      };
    if (!config.elicit)
      return {
        denied: errorResult(new ToolError("denied", reason)),
        review: review("denied", "unavailable"),
      };
    const req: ElicitRequest = {
      tool: name,
      args: ctx.args,
      reason: decision.reason,
      shell: ctx.shell,
      ...(decision.escalate !== undefined ? { escalate: decision.escalate } : {}),
    };
    const answer = await config.elicit(req);
    const allowed = answer === true || (typeof answer === "object" && answer.allowed === true);
    const answerer = typeof answer === "object" ? answer.answerer : "human";
    return allowed
      ? { review: review("allowed", answerer) }
      : {
          denied: errorResult(new ToolError("denied", `command review did not approve: ${reason}`)),
          review: review("denied", answerer),
        };
  } catch (err) {
    return { denied: errorResult(err) };
  }
}

/**
 * Validate, gate, and execute a single tool call, returning its result.
 *
 * @param name - the tool to invoke.
 * @param args - the raw caller arguments; a clone is validated (and mutated by
 *   defaulting/coercion) against the tool's schema before the handler sees it,
 *   so the caller's object is left untouched (see the `@remarks`).
 * @param config - the resolved server config selecting the surface and limits.
 * @param signal - optional abort signal forwarded to the handler.
 * @param hooks - optional {@link ToolCallHooks} for live output.
 * @returns a {@link DispatchResult}; failures are reported in-band as
 *   `isError: true`, never thrown. Unknown tools yield `not_found`, schema
 *   violations `invalid_input`, a blocked guard `denied`, and a throwing
 *   handler its {@link serializeError} rendering.
 * @remarks Text parts of a non-`bounded` tool are clamped to
 *   {@link RuntimeConfig.maxOutputBytes}; a `bounded` tool's output passes
 *   through untouched. Arguments are `structuredClone`d before validation, so
 *   the caller's object is not mutated.
 */
export async function dispatch(
  name: string,
  args: Record<string, unknown>,
  config: RuntimeConfig,
  signal?: AbortSignal,
  hooks?: ToolCallHooks,
): Promise<DispatchResult> {
  const tool = getTool(name, selectSurface(config.readOnly));
  if (!tool) {
    return errorResult(new ToolError("not_found", `Unknown tool: ${name}`));
  }

  const validate = validators.get(name)!;
  const filled = structuredClone(args);
  if (!validate(filled)) {
    const detail = ajv.errorsText(validate.errors, { separator: "; " });
    return errorResult(new ToolError("invalid_input", detail || "invalid arguments"));
  }

  try {
    protectSkillPackages(name, filled, config);
  } catch (error) {
    return errorResult(error);
  }

  const gate = await applyGuard(name, filled, config);
  if (gate.denied) return { ...gate.denied, ...(gate.review ? { guard: gate.review } : {}) };

  try {
    const { content, meta } = normalizeOutput(await tool.handler(filled, config, signal, hooks));
    const parts = typeof content === "string" ? [textPart(content)] : content;
    return {
      isError: false,
      content: boundParts(parts, tool.bounded, config.maxOutputBytes),
      ...(meta ? { meta: boundMeta(meta, config.maxToolMetaBytes) } : {}),
      ...(gate.review ? { guard: gate.review } : {}),
    };
  } catch (err) {
    const failed = errorResult(err);
    return { ...failed, ...(gate.review ? { guard: gate.review } : {}) };
  }
}
