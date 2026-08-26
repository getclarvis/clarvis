/**
 * Resolution of plugin-declared bootstrap skills: the gates a declared bootstrap
 * must clear before its body is injected into the system prompt.
 *
 * Pure and filesystem-free — every input arrives through the loader port — so the
 * gates are testable without driving a run.
 */
import { resolve } from "node:path";
import type { SkillContent } from "./types.ts";
import type { Logger } from "@clarvis/capability";

/**
 * Cap on the length of one bootstrap skill's body, in characters.
 *
 * @remarks A longer body is skipped with a warning, never truncated: half a
 * methodology is worse guidance than none, and silent truncation would consume the
 * context window without saying so.
 */
export const BOOTSTRAP_SKILL_MAX_CHARS = 20_000;

/**
 * Cap on the combined length of every bootstrap body admitted in one run, in
 * characters.
 *
 * @remarks Bounds the multi-plugin case, which {@link BOOTSTRAP_SKILL_MAX_CHARS}
 * alone does not: admission stops at the first entry that would exceed this, so two
 * methodology plugins cannot together crowd out the conversation.
 */
export const BOOTSTRAP_SKILLS_RUN_BUDGET_CHARS = 40_000;

/**
 * One plugin's declared bootstrap skill, as resolved by the host.
 *
 * @remarks The type that crosses the kernel → loop seam. `root` is the declaring
 * plugin's own skills root rather than its install directory, so the loop never
 * learns where a plugin keeps its skills — that layout fact stays in the kernel —
 * and the "is this the plugin's own skill?" check is a direct comparison against
 * the root a skill was scanned from.
 */
export interface PluginBootstrapSkill {
  /** The declaring plugin's name, as it appears in `enabledPlugins`. */
  plugin: string;
  /** The manifest's `bootstrapSkill` value: a skill name, not yet known to exist. */
  skill: string;
  /**
   * Absolute paths of the declaring plugin's own skills roots.
   *
   * @remarks Plural because a manifest may declare several skill locations, and
   *   the bootstrap it names can sit under any of them. Carrying only the first
   *   made a legitimate bootstrap resolve to a root it was not compared against
   *   and be dropped as {@link BootstrapRejection | foreign_root} — a
   *   security-flavoured rejection for an entirely ordinary layout.
   */
  roots: readonly string[];
}

/**
 * The one provider method this module needs, matching `SkillsProvider["loadSkill"]`.
 *
 * @remarks Declared locally rather than imported from `skills-tool.ts`, which
 * imports this module's {@link ResolvedBootstrapSkill} for rendering.
 */
export type BootstrapSkillLoader = (name: string) => SkillContent | undefined;

/** A declared bootstrap that cleared every gate; its body is injected verbatim. */
export interface ResolvedBootstrapSkill {
  /** The declaring plugin's name. */
  plugin: string;
  /** The resolved skill's own name, as parsed from its frontmatter. */
  skill: string;
  /** The skill's full body. */
  body: string;
}

/**
 * Why one declared bootstrap was dropped.
 *
 * @remarks `foreign_root` is the security-relevant one: the named skill resolved,
 * but to a skill scanned from someone else's root.
 */
type BootstrapRejection =
  "not_found" | "load_failed" | "foreign_root" | "empty_body" | "too_long" | "over_run_budget";

/**
 * Resolve the bootstrap skills a run should inject, in declaration order.
 *
 * @param args.refs - the declared bootstraps, in `enabledPlugins` order.
 * @param args.loadSkill - loads a skill by name from the run's merged catalog.
 * @param args.logger - receives one warning per dropped entry, and one more when
 *   several plugins each contribute a mandatory framing.
 * @returns the admitted bootstraps, in the order given; empty when none qualify.
 * @remarks Never throws: a loader failure, a missing skill, a shadowed skill, an
 *   empty or oversized body, and an exhausted run budget all resolve to a warning
 *   and a skip, because a misconfigured plugin must not be able to fail a run or
 *   suppress the skill catalog.
 *
 *   A skill is admitted only when it was scanned from the declaring plugin's own
 *   root. Without that check any enabled plugin could promote any skill on the
 *   machine — including one the user wrote — into a mandatory instruction. It also
 *   makes shadowing safe: plugin roots are scanned at the lowest precedence, so a
 *   same-named skill from a user root wins the merge and the bootstrap is then
 *   correctly refused rather than silently promoting someone else's text.
 */
export function resolveBootstrapSkills(args: {
  refs: readonly PluginBootstrapSkill[];
  loadSkill: BootstrapSkillLoader;
  logger?: Logger;
}): ResolvedBootstrapSkill[] {
  const admitted: ResolvedBootstrapSkill[] = [];
  let used = 0;

  const drop = (ref: PluginBootstrapSkill, reason: BootstrapRejection, detail = {}): void => {
    args.logger?.warn(
      { plugin: ref.plugin, skill: ref.skill, reason, ...detail },
      "bootstrap_skill_skipped: a plugin's declared bootstrap skill was not injected",
    );
  };

  for (const ref of args.refs) {
    let content: SkillContent | undefined;
    try {
      content = args.loadSkill(ref.skill);
    } catch (err) {
      drop(ref, "load_failed", { cause: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (content === undefined) {
      drop(ref, "not_found");
      continue;
    }
    if (!ref.roots.some((root) => resolve(root) === resolve(content.root))) {
      drop(ref, "foreign_root", { expected: ref.roots.join(", "), actual: content.root });
      continue;
    }
    if (content.body.trim().length === 0) {
      drop(ref, "empty_body");
      continue;
    }
    if (content.body.length > BOOTSTRAP_SKILL_MAX_CHARS) {
      drop(ref, "too_long", { chars: content.body.length, max: BOOTSTRAP_SKILL_MAX_CHARS });
      continue;
    }
    if (used + content.body.length > BOOTSTRAP_SKILLS_RUN_BUDGET_CHARS) {
      drop(ref, "over_run_budget", { used, budget: BOOTSTRAP_SKILLS_RUN_BUDGET_CHARS });
      break;
    }
    used += content.body.length;
    admitted.push({ plugin: ref.plugin, skill: content.name, body: content.body });
  }

  if (admitted.length > 1) {
    args.logger?.warn(
      { plugins: admitted.map((entry) => entry.plugin) },
      "bootstrap_skills_multiple: several plugins each inject a mandatory framing into every " +
        "agent's system prompt; competing methodologies are usually a misconfiguration",
    );
  }
  return admitted;
}
