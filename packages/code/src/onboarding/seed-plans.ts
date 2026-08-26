import { defaultPlansSettings, type Scope, type SettingsAdapter } from "../adapters/settings.ts";
import { seedBlockOnce } from "./seed-block-once.ts";

/** What {@link seedPlansBlock} did, so the caller can decide whether to tell the
 * user and re-run the doctor gates. */
export type PlansSeedOutcome =
  | { seeded: false; reason: "already-configured" | "no-settings-file" | "corrupt" }
  | { seeded: true; scope: Scope };

/**
 * Give a workspace an explicit planning policy the first time it is used.
 *
 * Planning is a policy the user should be able to see and change, not an
 * invisible default. Writing the block once — into the **global** scope, so
 * every workspace inherits it — makes the policy legible in Run Controls and
 * attributable to a scope.
 *
 * @param settings - the settings adapter; the block goes to the global scope.
 * @returns what happened, so the caller can notify only on a real write.
 *
 * @remarks
 * Idempotent by construction: turning planning off persists `mode: "off"` rather
 * than deleting the block, so a user's opt-out is never re-seeded. Seeding
 * refuses to run when no `settings.json` exists in either scope — creating that
 * file is the doctor's `config` gate's job, not this one's — and when either
 * scope is corrupt, since the write would fail anyway.
 */
export async function seedPlansBlock(settings: SettingsAdapter): Promise<PlansSeedOutcome> {
  return seedBlockOnce(settings, {
    alreadyConfigured: () => settings.effective().plans !== undefined,
    buildPatch: () => ({ plans: defaultPlansSettings() }),
  });
}
