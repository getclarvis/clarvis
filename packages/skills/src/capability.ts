/**
 * Skills (@clarvis/skills) packaged as a capability: run-level
 * enablement (env flag + provider), per-agent gating on the 'use_skills'
 * grant, the catalog rendered into the agent's system prompt, and the
 * load_skill tool with its handler.
 *
 * The catalog is resolved lazily, once per run: systemSection and forAgent
 * must serve the same listing, and a single scan also covers every spawned
 * subagent in the run.
 */
import type { SkillInfo } from "./types.ts";
import type {
  AgentCapability,
  Capability,
  RunCapability,
  RunCapabilityContext,
  ToolEffect,
} from "@clarvis/capability";
import type { ToolHandler, HandlerVerdict } from "@clarvis/capability";
import { handlerBaseOf, type HandlerBase } from "@clarvis/capability";
import { handleLoadSkillCall } from "./call.ts";
import {
  resolveBootstrapSkills,
  type PluginBootstrapSkill,
  type ResolvedBootstrapSkill,
} from "./bootstrap.ts";
import {
  LOAD_SKILL_TOOL_NAME,
  loadSkillTool,
  renderSkillsSection,
  type SkillsProvider,
} from "./tool.ts";

export {
  LOAD_SKILL_TOOL_NAME,
  SKILL_RESOURCE_MAX_CHARS,
  loadSkillTool,
  renderSkillsSection,
  type SkillsProvider,
} from "./tool.ts";
export { handleLoadSkillCall, type LoadSkillCallResult } from "./call.ts";
export {
  resolveBootstrapSkills,
  BOOTSTRAP_SKILL_MAX_CHARS,
  BOOTSTRAP_SKILLS_RUN_BUDGET_CHARS,
  type BootstrapSkillLoader,
  type PluginBootstrapSkill,
  type ResolvedBootstrapSkill,
} from "./bootstrap.ts";

/** Registry name of the skills capability. */
export const SKILLS_CAPABILITY_NAME = "skills";

/** Grant owned by this capability and admitted before request validation. */
export const USE_SKILLS_GRANT = "use_skills";

/** The capability metadata is derived from the same descriptor it advertises. */
const SKILLS_TOOLS = [loadSkillTool] as const;
const SKILLS_TOOL_WIRE_NAMES: readonly string[] = SKILLS_TOOLS.map((tool) => tool.wireName);
const SKILLS_TOOL_EFFECTS: Readonly<Record<string, ToolEffect>> = Object.fromEntries(
  SKILLS_TOOLS.map((tool) => [tool.wireName, "control"] as const),
);

/** Host wiring for the skills capability beyond the provider itself. */
export interface SkillsCapabilityOptions {
  /**
   * Plugin-declared bootstrap skills, in `enabledPlugins` order.
   *
   * @remarks Called once per run, never cached across runs, so enabling or
   *   disabling a plugin takes effect without restarting the host.
   */
  bootstraps?: () => readonly PluginBootstrapSkill[];
}

/**
 * Build the skills capability over an optional {@link SkillsProvider}.
 *
 * @param provider - Supplies the skill catalog and load-skill resolution; when
 *   absent the capability is inactive.
 * @param options - Host wiring; see {@link SkillsCapabilityOptions}.
 * @returns A {@link Capability} whose `forRun` returns null unless
 *   `CLARVIS_SKILLS_ENABLED` is set and a provider is present; when active it
 *   renders any plugin bootstrap bodies and the catalog into the system prompt and
 *   exposes `load_skill` for any agent carrying the `use_skills` grant.
 */
export function createSkillsCapability(
  provider?: SkillsProvider,
  options: SkillsCapabilityOptions = {},
): Capability {
  return {
    name: SKILLS_CAPABILITY_NAME,
    grants: [{ name: USE_SKILLS_GRANT }],
    reservedWireNames: SKILLS_TOOL_WIRE_NAMES,
    toolEffects: SKILLS_TOOL_EFFECTS,
    forRun(ctx): RunCapability | null {
      if (!ctx.env.CLARVIS_SKILLS_ENABLED || provider === undefined) return null;
      return createSkillsRunCapability(provider, options, ctx);
    },
  };
}

/**
 * Per-run skills activation. The catalog is scanned once and memoized, and the
 * plugin bootstraps are resolved once, so `systemSection` and `forAgent` serve the
 * same listing across the entry agent and every spawned subagent; an agent without
 * the `use_skills` grant or a run with an empty catalog gets neither the section
 * nor the tool.
 */
function createSkillsRunCapability(
  provider: SkillsProvider,
  options: SkillsCapabilityOptions,
  ctx: RunCapabilityContext,
): RunCapability {
  const availableMcpServers = new Set(ctx.request.servers.map((server) => server.name));
  const dependenciesAvailable = (skill: SkillInfo): boolean => {
    const plugin = skill.source.startsWith("plugin:")
      ? skill.source.slice("plugin:".length)
      : undefined;
    return (skill.dependencies ?? []).every(
      (dependency) =>
        availableMcpServers.has(dependency.value) ||
        (plugin !== undefined && availableMcpServers.has(`${plugin}:${dependency.value}`)),
    );
  };
  let catalog: SkillInfo[] | undefined;
  const listOnce = (): SkillInfo[] =>
    (catalog ??= provider.listSkills().filter(dependenciesAvailable));
  const catalogFor = (grants: readonly string[]): SkillInfo[] | undefined => {
    if (!grants.includes(USE_SKILLS_GRANT)) return undefined;
    const listed = listOnce();
    return listed.length > 0 ? listed : undefined;
  };

  let bootstrapsResolved = false;
  let bootstraps: ResolvedBootstrapSkill[] = [];
  /**
   * Resolve the run's bootstraps at most once.
   *
   * @remarks Guarded by an explicit flag rather than `??=`: "no valid bootstrap"
   *   is the common result, and `??=` would re-resolve — and re-warn — on every
   *   agent spawn. Resolution is lazy so a run whose agents never carry
   *   `use_skills` neither loads a bootstrap nor warns about one. A host port that
   *   throws is treated as declaring none, so a broken plugin loader degrades the
   *   run to a plain catalog rather than failing it.
   */
  const bootstrapsOnce = (): ResolvedBootstrapSkill[] => {
    if (!bootstrapsResolved) {
      bootstrapsResolved = true;
      let refs: readonly PluginBootstrapSkill[] = [];
      try {
        refs = options.bootstraps?.() ?? [];
      } catch (err) {
        ctx.logger?.warn(
          { cause: err instanceof Error ? err.message : String(err) },
          "bootstrap_skills_unavailable: could not read the plugins' declared bootstrap skills",
        );
      }
      bootstraps = resolveBootstrapSkills({
        refs,
        loadSkill: (name) => provider.loadSkill(name),
        ...(ctx.logger !== undefined ? { logger: ctx.logger } : {}),
      });
    }
    return bootstraps;
  };

  return {
    name: SKILLS_CAPABILITY_NAME,
    /**
     * @remarks The section is omitted when it would be empty, which a non-empty
     *   catalog can still produce: every skill in it may be withheld from the
     *   model's catalog. The `load_skill` tool is *not* withheld with it —
     *   suppression hides a skill from the listing, never from an explicit call.
     */
    systemSection(id): string | undefined {
      const listed = catalogFor(id.grants);
      if (listed === undefined) return undefined;
      const section = renderSkillsSection(listed, bootstrapsOnce());
      return section.length > 0 ? section : undefined;
    },
    forAgent(scope): AgentCapability | null {
      if (catalogFor(scope.grants) === undefined) return null;
      return {
        attach(bc) {
          return {
            tools: [loadSkillTool],
            handlers: [buildSkillsHandler({ base: handlerBaseOf(bc), skills: provider })],
            advertised: false,
          };
        },
      };
    },
  };
}

/**
 * The `load_skill` tool handler: resolves a skill's body/resources via the
 * provider and returns a result whose `progress` is true unless the outcome
 * carried an error.
 */
function buildSkillsHandler(deps: { base: HandlerBase; skills: SkillsProvider }): ToolHandler {
  const { base } = deps;
  return {
    matches: (call) => call.name === LOAD_SKILL_TOOL_NAME,
    handle(call, iteration): Promise<HandlerVerdict> {
      const oc = handleLoadSkillCall({
        call,
        skills: deps.skills,
        trace: base.trace,
        agent: base.agent,
        ...(base.subagentInstanceId !== undefined
          ? { subagentInstanceId: base.subagentInstanceId }
          : {}),
        iteration,
        ...(base.validateArgs !== undefined ? { validateArgs: base.validateArgs } : {}),
      });
      return Promise.resolve({ kind: "result", text: oc.text, progress: !oc.error });
    },
  };
}
