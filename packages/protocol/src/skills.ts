/**
 * SkillsService — user-invocable skills a UI turns into slash-commands.
 *
 * A skill either names an agent — and runs as its own run on that agent — or names
 * none, and its instructions are rendered and injected into the current turn. This
 * is the protocol-owned surface; the kernel serves it from its skills registry,
 * so a UI never lists "MCP prompts" to discover skills.
 */

import type { Message, PlansMode } from "./runs.ts";

/** One named argument a skill accepts. */
export interface SkillArgument {
  name: string;
  description?: string;
  /** When `true`, the argument must be supplied to invoke the skill. */
  required?: boolean;
}

/**
 * Where a skill came from, so a UI can attribute it.
 *
 * @remarks
 * Read-only provenance: Clarvis reports what the scan and the skill's own
 * frontmatter already say, and never writes a manifest, lockfile or hash of its
 * own. Installing and updating a skill package stays the responsibility of the
 * tool that produced it.
 */
export interface SkillProvenance {
  /** Whether the skill was scanned from a home-level or workspace-level root. */
  scope: "user" | "workspace";
  /** Provenance tag of the root it was scanned from: `agents`, `clarvis`,
   * `plugin:<plugin-name>`, … */
  source?: string;
  /** The producing tool's `metadata.author` frontmatter, when it wrote one. */
  author?: string;
}

/** Skill-relative icon paths, keyed by the theme each is drawn for. */
export interface SkillIconSet {
  light?: string;
  dark?: string;
}

/**
 * How a skill asks to be presented, for a UI that lists or previews it.
 *
 * @remarks
 * Presentation only. None of it is ever shown to the model, and none of it is
 * authorization: a display name does not rename the skill, an icon path is a
 * path the kernel has already confined to the skill directory, and a starter
 * prompt is a suggestion a user may edit or ignore. Every field is optional,
 * including for a skill that declares no presentation at all.
 */
export interface SkillPresentation {
  /** Name to show in place of the skill's own, which stays the invocation key. */
  displayName?: string;
  /** One line, shorter than `description`, for a dense list row. */
  shortDescription?: string;
  /** Skill-relative icon paths. */
  icons?: SkillIconSet;
  /** Brand colour in hex notation. */
  color?: string;
  /** A prompt to offer as the starting point when the skill is picked. */
  starterPrompt?: string;
}

/** List projection of a skill. */
export interface SkillSummary {
  /** Skill name; the slash-command a UI exposes it under. */
  name: string;
  description: string;
  /**
   * The agent the skill declared for itself. When present the skill starts a run
   * of its own on that agent; when absent it is injected as a prompt into the
   * current turn. Carrying the name rather than a flag lets a UI attribute the
   * run without a second lookup.
   */
  agent?: string;
  /** Declared arguments, for a UI to prompt/validate against. */
  arguments?: SkillArgument[];
  /** Where the skill came from; absent when the kernel cannot attribute it. */
  provenance?: SkillProvenance;
  /** How the skill asks to be presented; absent when it declares nothing. */
  presentation?: SkillPresentation;
  /** Trusted effective Plans override for this skill run, when one applies. */
  plansMode?: PlansMode;
}

/** List and render skills for the UI. */
export interface SkillsService {
  /** All skills available in the bound workspace. */
  list(): Promise<SkillSummary[]>;

  /**
   * Render a skill's prompt messages for a skill that names no agent, to inject
   * into the current turn.
   *
   * @param name - Skill name.
   * @param args.task - Optional target the skill acts on.
   * @returns The rendered prompt messages to inject into the current turn.
   */
  getPrompt(name: string, args?: { task?: string }): Promise<Message[]>;
}
