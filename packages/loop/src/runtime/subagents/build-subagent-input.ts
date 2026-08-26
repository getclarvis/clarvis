import type { ImagePart, Message, TracePort } from "@clarvis/capability";
import { contentToText } from "@clarvis/capability";
import type { NamespacedRegistry } from "@clarvis/capability";
import { SUBAGENT_NO_PROGRESS_LIMIT } from "../loop/loop-shared.ts";
import type { RunAgentInput } from "../loop/run-agent.ts";

/**
 * How a command reaches the host on a given platform, in the terms a model
 * needs to write one.
 *
 * @remarks Deliberately a local two-line derivation rather than an import of
 *   `@clarvis/tools`' `currentShellFlavor`. That package is an
 *   `optionalDependency` of the engine, and a run configured with
 *   `builtins.tools = false` still has a system prompt.
 */
function shellLine(platform: NodeJS.Platform): string {
  return platform === "win32"
    ? "Shell: PowerShell (pwsh/powershell.exe) — not sh, and not cmd.exe."
    : "Shell: sh, invoked as `sh -c`.";
}

/**
 * Renders the `# Environment` system-prompt section: the workspace root, the
 * host platform, and how a shell command is run.
 *
 * @param workspaceRoot - the run's workspace root.
 * @param platform - the host platform; defaults to `process.platform`.
 * @remarks The platform line is not decoration. Until it existed the **only**
 *   signal of the host OS anywhere in a run was the wording inside the `shell`
 *   tool's own description, and only on Windows — so on a POSIX host the model
 *   was told nothing at all and had to guess from path separators. Naming it in
 *   the system prompt is what lets a model choose `rm -rf` over `Remove-Item`
 *   deliberately rather than by luck.
 *
 *   What is **not** here, on purpose, is a probe of `PATH`. Reporting which
 *   binaries resolve invites the model to pick a toolchain from what is
 *   installed, and the installed set is the weaker evidence: a machine with both
 *   `npm` and `bun` on `PATH` says nothing about which one this repository uses,
 *   while its lockfile says it exactly and the model can read that with the
 *   tools it already has.
 */
function environmentPreamble(workspaceRoot: string, platform: NodeJS.Platform): string {
  return [
    "# Environment",
    "",
    `Workspace root: ${workspaceRoot}`,
    `OS: ${platform}`,
    shellLine(platform),
  ].join("\n");
}

/**
 * Assembles the ordered system-prompt sections for an agent: an optional
 * environment preamble, the profile's base prompt, then any
 * capability-contributed sections.
 *
 * @param p - the pieces to include; a missing/empty field is skipped.
 * @returns the sections in order (environment, base prompt, capability
 *   sections), ready to join with blank lines; empty when nothing was supplied.
 */
export function buildSystemSections(p: {
  workspaceRoot?: string;
  basePrompt?: string;
  /** Capability-contributed sections (e.g. the skills catalog), appended last. */
  capabilitySections?: readonly string[];
  /** Host platform for the environment section; defaults to `process.platform`. */
  platform?: NodeJS.Platform;
}): string[] {
  const sections: string[] = [];
  if (p.workspaceRoot !== undefined)
    sections.push(environmentPreamble(p.workspaceRoot, p.platform ?? process.platform));
  if (p.basePrompt && p.basePrompt.length > 0) sections.push(p.basePrompt);
  for (const s of p.capabilitySections ?? []) sections.push(s);
  return sections;
}

/**
 * Concatenates the text of every user message into one trimmed string.
 *
 * @param messages - the seed conversation.
 * @returns the user turns' text joined by blank lines; used as the sub-agent's
 *   `staticAnchor` body ("Current task").
 */
export function userText(messages: readonly Message[]): string {
  return messages
    .filter((m) => m.role === "user")
    .map((m) => contentToText(m.content))
    .join("\n\n")
    .trim();
}

/**
 * Gathers every image part carried by the user messages of a turn.
 *
 * @param messages - the turn's messages.
 * @returns the image parts in message/part order; string-content and non-user
 *   messages contribute none.
 */
export function collectTurnImages(messages: readonly Message[]): ImagePart[] {
  const images: ImagePart[] = [];
  for (const m of messages) {
    if (m.role !== "user" || typeof m.content === "string") continue;
    for (const part of m.content) {
      if (part.type === "image") images.push(part);
    }
  }
  return images;
}

/**
 * The subset of {@link RunAgentInput} that shapes a sub-agent's loop behavior —
 * progress signalling, the pinned "Current task" anchor, the
 * all-tools-unavailable guard, the no-progress convergence message, and the
 * `onStart` delegation trace.
 *
 * @remarks Produced by {@link buildSubagentInputPersona}; the lead's counterpart
 *   is `LeadPersona`.
 */
export type SubagentPersona = Pick<
  RunAgentInput,
  | "mcpProgress"
  | "staticAnchor"
  | "allToolsUnavailable"
  | "noProgressLimit"
  | "noProgressMessage"
  | "emptyResponseAgent"
  | "onStart"
>;

/**
 * Inputs for {@link buildSubagentInputPersona}: the sub-agent's tool `registry`,
 * the `subagentTaskBody` pinned as the static anchor, its `subagentInstanceId`
 * and `model` for the start trace, the `trace` handle, and whether the built-in
 * coding toolset is active (`hasBuiltinTools`).
 */
export interface SubagentPersonaParams {
  registry: NamespacedRegistry;
  subagentTaskBody: string;
  subagentInstanceId: string;
  model: string;
  trace: TracePort;
  hasBuiltinTools: boolean;
}

/**
 * Builds a sub-agent's {@link SubagentPersona} from {@link SubagentPersonaParams}.
 *
 * @param params - the sub-agent's registry, task body, identity, and toolset
 *   flag; see {@link SubagentPersonaParams}.
 * @returns the persona spread into the sub-agent's `runAgent` call.
 * @remarks The `staticAnchor` is included only when `subagentTaskBody` is
 *   non-empty. `allToolsUnavailable` reports true only when the built-in toolset
 *   is inactive and the registry is non-empty yet fully unavailable. The
 *   no-progress limit is {@link SUBAGENT_NO_PROGRESS_LIMIT}; `onStart` records a
 *   `delegation_started` trace event tagged with the instance id and model.
 */
export function buildSubagentInputPersona(params: SubagentPersonaParams): SubagentPersona {
  const { registry, subagentTaskBody, subagentInstanceId, model, trace, hasBuiltinTools } = params;
  return {
    mcpProgress: (r) => r.errText === null,
    ...(subagentTaskBody.length > 0
      ? { staticAnchor: { label: "Current task", body: subagentTaskBody } }
      : {}),
    allToolsUnavailable: () =>
      !hasBuiltinTools && registry.tools.length > 0 && registry.allUnavailable(),
    noProgressLimit: SUBAGENT_NO_PROGRESS_LIMIT,
    noProgressMessage: (streak) =>
      `Sub-agent made no progress for ${streak} consecutive iterations (no result submitted, no successful tool call).`,
    emptyResponseAgent: "LLM",
    onStart: () =>
      trace.record("delegation_started", {
        delegation_id: subagentInstanceId,
        model,
      }),
  };
}
