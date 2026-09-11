import { splitFrontmatterFence } from "@clarvis/capability";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { INPUT_LIMITS } from "../../validation/input-limits.ts";
import { DEFAULT_SHARED_AGENT_PROMPT } from "./shared-agent-prompt.ts";

/** Which layer supplied the effective shared prompt. */
export type SharedPromptSource = "builtin" | "global" | "workspace" | "disabled";

/** Why one config-scope document was not used. */
export interface SharedPromptDiagnostic {
  scope: "global" | "workspace";
  path: string;
  reason: string;
}

/**
 * The single shared prompt a run will use, plus why any higher-precedence
 * document was skipped.
 *
 * @remarks `prompt` is omitted when the winning layer disabled the shared
 * layer. `source` and `diagnostics` are host-facing; they must not be copied
 * into the system head.
 */
export interface ResolvedSharedPrompt {
  prompt?: string;
  source: SharedPromptSource;
  /** Config scope that won, when the winner is a file rather than the builtin. */
  from?: "global" | "workspace";
  diagnostics: SharedPromptDiagnostic[];
}

/** One already-read config-scope document, or the reason it could not be read. */
export interface SharedPromptLayer {
  path: string;
  /** File bytes as UTF-8 when the file exists and was readable. */
  raw?: string;
  unreadable?: boolean;
  oversized?: boolean;
  /** Workspace layers only. `false` withholds the override. */
  trusted?: boolean;
}

/** Already-read global and workspace documents for {@link resolveSharedPrompt}. */
export interface ResolveSharedPromptInput {
  workspace?: SharedPromptLayer;
  global?: SharedPromptLayer;
}

const frontmatterSchema = z
  .object({
    mode: z.enum(["replace", "disabled"]),
  })
  .strict();

/** A successfully parsed shared-prompt document. */
export type ParsedSharedPrompt =
  { ok: true; mode: "replace"; body: string } | { ok: true; mode: "disabled" };

/** A shared-prompt document that cannot be applied. */
export type SharedPromptParseFailure = { ok: false; reason: string };

/**
 * Parse one shared-prompt markdown document.
 *
 * @param raw - the file contents.
 * @returns a replace/disabled document, or a reason the layer must be skipped.
 * @remarks Missing `mode`, `replace` without a body, `disabled` with a body,
 * unknown keys, and an over-long body are all complete failures. An empty file
 * is not a silent disable.
 */
export function parseSharedPromptDocument(
  raw: string,
): ParsedSharedPrompt | SharedPromptParseFailure {
  const fence = splitFrontmatterFence(raw);
  if (fence.kind === "unterminated") {
    return { ok: false, reason: "frontmatter is unterminated" };
  }
  if (fence.kind === "absent") {
    return { ok: false, reason: "frontmatter is missing" };
  }

  let data: unknown;
  try {
    data = fence.frontmatter.trim().length === 0 ? {} : parseYaml(fence.frontmatter);
  } catch {
    return { ok: false, reason: "frontmatter is not valid YAML" };
  }

  const parsed = frontmatterSchema.safeParse(data);
  if (!parsed.success) {
    return { ok: false, reason: "mode must be replace or disabled" };
  }

  const body = fence.body.trim();
  if (parsed.data.mode === "disabled") {
    if (body.length > 0) return { ok: false, reason: "disabled requires an empty body" };
    return { ok: true, mode: "disabled" };
  }
  if (body.length === 0) return { ok: false, reason: "replace requires a non-empty body" };
  if (body.length > INPUT_LIMITS.systemPromptChars) {
    return { ok: false, reason: "prompt exceeds the character limit" };
  }
  return { ok: true, mode: "replace", body };
}

/**
 * Serialize a shared-prompt document for an editor save.
 *
 * @param mode - `replace` or `disabled`.
 * @param body - the prompt body; ignored when `mode` is `disabled`.
 */
export function renderSharedPromptDocument(mode: "replace" | "disabled", body = ""): string {
  const frontmatter = `---\nmode: ${mode}\n---\n`;
  if (mode === "disabled") return `${frontmatter}\n`;
  return `${frontmatter}\n${body.trimEnd()}\n`;
}

/**
 * Choose exactly one shared prompt from already-read layers.
 *
 * @param input - optional workspace then global documents.
 * @returns the winning prompt, or none when the winning layer disabled it.
 * @remarks Last-wins among *valid* layers: a trusted workspace document, else a
 * global document, else {@link DEFAULT_SHARED_AGENT_PROMPT}. An untrusted,
 * unreadable, oversized, or invalid layer is skipped whole; the next valid
 * layer is used rather than concatenating fragments.
 */
export function resolveSharedPrompt(input: ResolveSharedPromptInput = {}): ResolvedSharedPrompt {
  const diagnostics: SharedPromptDiagnostic[] = [];
  const workspace = considerLayer("workspace", input.workspace, diagnostics);
  if (workspace !== undefined) return { ...workspace, diagnostics };
  const global = considerLayer("global", input.global, diagnostics);
  if (global !== undefined) return { ...global, diagnostics };
  return { prompt: DEFAULT_SHARED_AGENT_PROMPT, source: "builtin", diagnostics };
}

function considerLayer(
  scope: "global" | "workspace",
  layer: SharedPromptLayer | undefined,
  diagnostics: SharedPromptDiagnostic[],
): Omit<ResolvedSharedPrompt, "diagnostics"> | undefined {
  if (layer === undefined) return undefined;
  if (scope === "workspace" && layer.trusted === false) {
    diagnostics.push({ scope, path: layer.path, reason: "workspace is not trusted" });
    return undefined;
  }
  if (layer.unreadable === true) {
    diagnostics.push({ scope, path: layer.path, reason: "file is unreadable" });
    return undefined;
  }
  const overLimit =
    layer.oversized === true ||
    (layer.raw !== undefined && layer.raw.length > INPUT_LIMITS.systemPromptChars);
  if (overLimit) {
    diagnostics.push({ scope, path: layer.path, reason: "prompt exceeds the character limit" });
    return undefined;
  }
  if (layer.raw === undefined) return undefined;

  const parsed = parseSharedPromptDocument(layer.raw);
  if (!parsed.ok) {
    diagnostics.push({ scope, path: layer.path, reason: parsed.reason });
    return undefined;
  }
  if (parsed.mode === "disabled") return { source: "disabled", from: scope };
  return { prompt: parsed.body, source: scope, from: scope };
}
