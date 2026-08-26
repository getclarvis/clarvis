/**
 * Dependency-free plugin-manifest contract for the skills capability.
 *
 * @remarks Kept in the engine, and import-clean of `@clarvis/skills`, on purpose.
 * `capabilityPluginFields` is consumed by `settings/plugin-schema.ts`, which
 * `src/host.ts` exports and the kernel imports, so a value import here would make
 * `@clarvis/loop/host` statically require the optional `@clarvis/skills` package —
 * which `tests/architecture/optional-package-loading.test.ts` exists to prevent. The
 * executable half (`createSkillsCapability`, the `load_skill` tool and its handler)
 * lives in `@clarvis/skills/capability` for the same reason.
 */
import { z } from "zod";

const BOOTSTRAP_SKILL_DESCRIPTION =
  "Name of one skill, shipped by THIS plugin, whose full body is injected into the system " +
  "prompt ahead of the skill catalog — for a methodology skill that must be read before the " +
  "model responds rather than loaded on demand. The name must resolve to this plugin's own " +
  "skills/ directory; if a higher-precedence root shadows it, it is skipped with a warning. " +
  "Bodies over 20000 characters are skipped, as is any entry past a " +
  "40000-character run-wide budget.";

/**
 * The `bootstrapSkill` entry of a plugin manifest.
 *
 * @remarks Deliberately carries no `CapabilitySettingsSpec` and is not
 * `pluginContributable`. Two consequences, both load-bearing:
 *
 * 1. `pluginSettingsFragment` never copies it, so it never travels the
 *    `settingsScopes` path — which filters on trusted plugins and would stop
 *    bootstraps loading for the `inert` plugins this exists to serve.
 * 2. It is not part of the plugin's executable surface, so a skills-only plugin
 *    stays `inert` and needs no approval dialog.
 *
 * Not regex-constrained on purpose, even though skill names are: a manifest field
 * that fails validation fails the whole manifest, which would leave the plugin
 * contributing nothing at all — not even its skills. A bad value is instead
 * reported at resolution time and skipped.
 */
export const SKILLS_PLUGIN_FIELDS = {
  bootstrapSkill: z.string().min(1).optional().describe(BOOTSTRAP_SKILL_DESCRIPTION),
};

/**
 * Re-export of the resolved-bootstrap type the kernel → loop seam carries.
 *
 * @remarks A `type` re-export, which the compiler erases — the whole point of
 *   this module is that nothing on the eager configuration path loads the
 *   optional `@clarvis/skills` package, and a value import would.
 */
export type { PluginBootstrapSkill } from "@clarvis/skills";
