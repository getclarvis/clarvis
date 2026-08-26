/**
 * Rendering a skill into the text that invokes it, plus the frontmatter probes
 * that decide how a skill is invoked.
 *
 * @remarks
 * Both skill invocation paths share this module: {@link
 * createSkillsService}'s `getPrompt`, which injects a skill into the current
 * turn, and the run-request assembler, which seeds a skill run. Which of the two
 * applies is decided by one field — {@link skillEntryAgent}.
 */

import type { SkillIconSet, SkillPresentation } from "@clarvis/protocol";

/** Target text substituted into the skill prompt when the caller supplies no explicit `task`. */
const NO_TASK_FALLBACK = "(no explicit target — apply the skill to the current conversation.)";

/**
 * Argument placeholders a skill body may use to position the caller's task
 * itself, rather than receiving it as a trailing `Target:` block.
 *
 * @remarks
 * `$ARGUMENTS` is the markdown/prompt-host form and `{{args}}` the TOML/YAML
 * one; these are the two dialects in circulation among the tools that write
 * into the `.agents/skills` roots Clarvis scans. The set is deliberately fixed:
 * no caller needs to configure it, and a third dialect is cheaper to add here
 * than to thread through as configuration.
 */
const ARGUMENT_PLACEHOLDERS = ["$ARGUMENTS", "{{args}}"] as const;

/**
 * One regex matching every placeholder the body actually uses.
 *
 * @param placeholders - the placeholders present in the body.
 * @returns a global alternation with each placeholder escaped.
 * @remarks Substitution has to happen in a **single** pass, with a replacer
 *   function rather than a replacement string. A string replacement expands
 *   `$$`, `$&`, `` $` `` and `$'` as substitution patterns, so a task like
 *   `explain $& in sed` re-emitted the placeholder instead of the argument, and
 *   `` fix $` quoting `` spliced the surrounding skill body into the argument
 *   slot. Substituting one placeholder at a time compounded it: a body using
 *   both forms would substitute a second time into an argument that happened to
 *   contain the other placeholder's text.
 */
function placeholderPattern(placeholders: readonly string[]): RegExp {
  const escaped = placeholders.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(escaped.join("|"), "g");
}

/**
 * Read a skill's nested frontmatter bucket.
 *
 * @param metadata - the skill's parsed frontmatter; the shape is loose (the
 *   schema is `.passthrough()`), so it is probed defensively.
 * @returns the inner `metadata:` mapping, or an empty object when absent.
 */
function metadataBucket(metadata: unknown): Record<string, unknown> {
  const outer = (metadata ?? {}) as { metadata?: unknown };
  return (outer.metadata ?? {}) as Record<string, unknown>;
}

/**
 * Resolve the agent a skill run should enter on.
 *
 * @param metadata - the skill's raw frontmatter.
 * @returns the agent named by the top-level `agent` field when it is a non-blank
 *   string, else `undefined`.
 * @remarks
 * This is the only thing that decides how a **user** invokes a skill, and the
 * absent case is not a lesser form of the present one: a skill naming an agent
 * becomes a run of its own on that agent, and a skill naming none is rendered
 * into the current turn. There is deliberately no way to ask for a separate run
 * without choosing whose it is.
 *
 * It does not govern the model-facing `load_skill` tool, which serves a skill's
 * body into the run that asked for it and never consults this field. A skill
 * naming an agent therefore runs on it when a user types `/name`, and in the
 * caller's own turn when an agent loads it mid-run.
 */
export function skillEntryAgent(metadata: unknown): string | undefined {
  const agent = (metadata as { agent?: unknown } | undefined)?.agent;
  if (typeof agent !== "string") return undefined;
  const name = agent.trim();
  return name.length > 0 ? name : undefined;
}

/**
 * Read a skill's declared argument hint.
 *
 * @param metadata - the skill's raw frontmatter.
 * @returns the top-level `argument-hint` when it is a non-blank string, else
 *   `undefined`.
 */
export function argumentHint(metadata: unknown): string | undefined {
  const hint = (metadata as { "argument-hint"?: unknown } | undefined)?.["argument-hint"];
  if (typeof hint !== "string") return undefined;
  const trimmed = hint.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Read the author a producing tool recorded in a skill's nested metadata.
 *
 * @param metadata - the skill's raw frontmatter.
 * @returns `metadata.author` when it is a non-blank string, else `undefined`.
 */
export function skillAuthor(metadata: unknown): string | undefined {
  const author = metadataBucket(metadata).author;
  if (typeof author !== "string") return undefined;
  const trimmed = author.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Read one bounded, non-blank string out of a loose presentation bucket.
 *
 * @param bucket - the candidate presentation mapping.
 * @param key - the field to read.
 * @returns the trimmed value, or `undefined` when it is absent or not a string.
 */
function presentationText(bucket: Record<string, unknown>, key: string): string | undefined {
  const value = bucket[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * An icon path that stays inside the skill directory it is relative to.
 *
 * @param bucket - the candidate icon mapping.
 * @param key - the theme slot to read.
 * @returns the path, or `undefined` when it is absent, not a string, or would
 *   escape the skill.
 * @remarks The protocol DTO documents these as already confined, and the builtin
 *   reader does confine them — but this projection exists precisely because the
 *   skills provider is a port a host may replace, and a claim a DTO makes has to
 *   be enforced by whoever asserts it. A UI opens these paths.
 */
function iconPath(bucket: Record<string, unknown>, key: string): string | undefined {
  const raw = presentationText(bucket, key);
  if (raw === undefined) return undefined;
  const normalized = raw.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) return undefined;
  return normalized.split("/").includes("..") ? undefined : raw;
}

/** Project the theme icon paths, dropping any slot that is not a confined path. */
function presentationIcons(value: unknown): SkillIconSet | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const bucket = value as Record<string, unknown>;
  const light = iconPath(bucket, "light");
  const dark = iconPath(bucket, "dark");
  if (light === undefined && dark === undefined) return undefined;
  return { ...(light === undefined ? {} : { light }), ...(dark === undefined ? {} : { dark }) };
}

/**
 * Project a scanned skill's presentation metadata onto the protocol DTO.
 *
 * @param presentation - whatever the skills provider put on the skill.
 * @returns the DTO, or `undefined` when nothing projects.
 * @remarks
 * The provider is a port, so this re-reads the shape rather than forwarding the
 * object: a host may supply its own implementation, and a UI field is a poor
 * place to discover that it supplied something else. Nothing here is ever shown
 * to the model — presentation is addressed to the harness, and this projection
 * feeds the picker alone.
 */
export function skillPresentation(presentation: unknown): SkillPresentation | undefined {
  if (typeof presentation !== "object" || presentation === null || Array.isArray(presentation)) {
    return undefined;
  }
  const bucket = presentation as Record<string, unknown>;
  const displayName = presentationText(bucket, "displayName");
  const shortDescription = presentationText(bucket, "shortDescription");
  const color = presentationText(bucket, "color");
  const starterPrompt = presentationText(bucket, "starterPrompt");
  const icons = presentationIcons(bucket["icons"]);
  const projected: SkillPresentation = {
    ...(displayName === undefined ? {} : { displayName }),
    ...(shortDescription === undefined ? {} : { shortDescription }),
    ...(icons === undefined ? {} : { icons }),
    ...(color === undefined ? {} : { color }),
    ...(starterPrompt === undefined ? {} : { starterPrompt }),
  };
  return Object.keys(projected).length > 0 ? projected : undefined;
}

/**
 * Assemble the user message that invokes a skill: a preamble naming the skill,
 * its description, and the skill body with the caller's target either
 * substituted into it or appended after it.
 *
 * @param name - the skill name.
 * @param description - the skill's one-line description.
 * @param body - the full skill instructions.
 * @param task - the caller's target for the skill.
 * @returns the rendered prompt text.
 *
 * @remarks
 * When the body carries an {@link ARGUMENT_PLACEHOLDERS | argument placeholder},
 * every occurrence is replaced with the task and no `Target:` block is appended
 * — the author has already said where the argument belongs. A missing task
 * substitutes as the empty string rather than as {@link NO_TASK_FALLBACK},
 * matching how every other host that implements `$ARGUMENTS` behaves: bodies
 * written against it guard on emptiness themselves, so injecting prose into a
 * slot the author expected to be empty would change their meaning.
 * {@link NO_TASK_FALLBACK} therefore applies only on the no-placeholder path,
 * where Clarvis authors the framing.
 */
export function renderSkillPrompt(
  name: string,
  description: string,
  body: string,
  task?: string,
): string {
  const trimmed = task !== undefined && task.trim().length > 0 ? task.trim() : undefined;
  const head = (lead: string): string[] => [
    `The user invoked the "${name}" skill.`,
    "",
    description,
    "",
    lead,
    "",
  ];

  const placeholders = ARGUMENT_PLACEHOLDERS.filter((p) => body.includes(p));
  if (placeholders.length > 0) {
    const substituted = body.replace(placeholderPattern(placeholders), () => trimmed ?? "");
    return [
      ...head("Follow the skill instructions below for this task."),
      "--- SKILL ---",
      substituted,
      "--- END SKILL ---",
    ].join("\n");
  }

  return [
    ...head(
      "Apply the skill instructions below to the target that follows. Follow them for this task.",
    ),
    "--- SKILL ---",
    body,
    "--- END SKILL ---",
    "",
    "Target:",
    trimmed ?? NO_TASK_FALLBACK,
  ].join("\n");
}
