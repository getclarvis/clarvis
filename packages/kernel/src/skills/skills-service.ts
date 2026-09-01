import type { SkillsProvider } from "@clarvis/loop";
import type { Message, SkillArgument, SkillSummary, SkillsService } from "@clarvis/protocol";
import type { PlansMode } from "@clarvis/protocol";
import { kernelError } from "../core/errors.ts";
import {
  argumentHint,
  renderSkillPrompt,
  skillAuthor,
  skillEntryAgent,
  skillPresentation,
} from "./render-skill-prompt.ts";

/** Configuration for {@link createSkillsService}. */
export interface SkillsServiceConfig {
  /** The skills source; when `undefined`, {@link SkillsService.list} returns empty and `getPrompt` always fails. */
  skills: SkillsProvider | undefined;
  /** Trusted effective Plans override for a scanned skill, when one applies. */
  skillPlansMode?: (skill: { name: string; source?: string }) => PlansMode | undefined;
}

/**
 * Adapt a {@link SkillsProvider} to the protocol {@link SkillsService}, exposing
 * user-invocable skills as slash commands and rendering a skill body into an
 * invocation message.
 *
 * @param cfg - the skills provider; see {@link SkillsServiceConfig}.
 * @returns a {@link SkillsService} that lists invocable skills and builds their
 *   prompts.
 */
export function createSkillsService(cfg: SkillsServiceConfig): SkillsService {
  return {
    /**
     * List the user-invocable skills as slash-command summaries.
     *
     * @returns each invocable skill's {@link SkillSummary} — name, description,
     *   the agent it runs on when it names one, its single optional `task`
     *   argument (described by the skill's `argument-hint` when it declares
     *   one), where it came from, and how it asks to be presented; empty when no
     *   provider is configured.
     * @remarks
     * The filter is `userInvocable` alone. A skill withheld from the *model's*
     * catalog is a separate axis and is deliberately not consulted here: it hides
     * an entry from the listing injected into a run, never from the user who
     * asked to see their own skills.
     */
    async list(): Promise<SkillSummary[]> {
      const provider = cfg.skills;
      if (provider === undefined) return [];
      return provider
        .listSkills()
        .filter((s) => s.userInvocable)
        .map((s) => {
          const hint = argumentHint(s.metadata);
          const task: SkillArgument = {
            name: "task",
            required: false,
            ...(hint !== undefined ? { description: hint } : {}),
          };
          const author = skillAuthor(s.metadata);
          const agent = skillEntryAgent(s.metadata);
          const presentation = skillPresentation((s as { presentation?: unknown }).presentation);
          const scope = s.scope === "user" || s.scope === "workspace" ? s.scope : undefined;
          const plansMode = cfg.skillPlansMode?.({
            name: s.name,
            ...(typeof s.source === "string" && s.source.length > 0 ? { source: s.source } : {}),
          });
          return {
            name: s.name,
            description: s.description,
            ...(agent !== undefined ? { agent } : {}),
            arguments: [task],
            ...(scope !== undefined
              ? {
                  provenance: {
                    scope,
                    ...(typeof s.source === "string" && s.source.length > 0
                      ? { source: s.source }
                      : {}),
                    ...(author !== undefined ? { author } : {}),
                  },
                }
              : {}),
            ...(plansMode !== undefined ? { plansMode } : {}),
            ...(presentation !== undefined ? { presentation } : {}),
            ...(s.dependencies !== undefined ? { dependencies: s.dependencies } : {}),
          };
        });
    },
    /**
     * Build the invocation messages for a named skill.
     *
     * @param name - the skill name.
     * @param args - optional invocation `task` (the target the skill acts on).
     * @returns a single user {@link Message} carrying the rendered skill prompt.
     * @throws {@link kernelError | KernelException} `not_found` when the skill is
     *   absent or not user-invocable.
     */
    async getPrompt(name: string, args?: { task?: string }): Promise<Message[]> {
      const content = cfg.skills?.loadSkill(name);
      if (content === undefined || !content.userInvocable) {
        throw kernelError("not_found", `skill '${name}' is not available`);
      }
      return [
        {
          role: "user",
          content: renderSkillPrompt(name, content.description, content.body, args?.task),
        },
      ];
    },
  };
}
