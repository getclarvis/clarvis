import type { Scope, SettingsAdapter } from "../adapters/settings.ts";
import { seedBlockOnce } from "./seed-block-once.ts";

/** What {@link seedMemoryBlock} did, so the caller can decide whether to tell
 * the user and re-run the doctor gates. */
export type MemorySeedOutcome =
  | { seeded: false; reason: "already-configured" | "no-settings-file" | "corrupt" }
  | { seeded: true; scope: Scope };

/**
 * Give a workspace an explicit memory policy the first time it is used.
 *
 * Memory is workspace infrastructure, not a feature a user has to discover: a
 * run that cannot recall what the last one learned is a default nobody chose.
 * Writing the block once — into the **global** scope, so every workspace
 * inherits it — makes the policy legible in Memory settings and attributable to
 * a scope.
 *
 * @param settings - the settings adapter; the block goes to the global scope.
 * @returns what happened, so the caller notifies only on a real write.
 *
 * @remarks
 * Idempotent by construction: turning memory off persists `enabled: false`
 * rather than deleting the block, so a user's opt-out is never re-seeded.
 * `model` is deliberately omitted — an absent one inherits `default_model`, and
 * naming a second model here would freeze a choice the user has not made.
 * Seeding refuses to run when no `settings.json` exists in either scope
 * (creating that file is the doctor's `config` gate's job) and when either
 * scope is corrupt, since the write would fail anyway. Those two refusals are
 * the only way the block is still absent once the shell has mounted, which is
 * why the doctor reports an absent block as a warning rather than as an opt-in
 * anyone chose.
 *
 * A caller that seeds mid-session **must** follow a successful write with both
 * `memoryMode.refresh()` and `memoryMode.setMode("on")`. The store freezes its
 * mode signal from `configured()` at construction, which happens before the
 * mount this runs in — without the pair the block lands on disk and every run
 * of that session still asks for `memory: "off"`.
 */
export async function seedMemoryBlock(settings: SettingsAdapter): Promise<MemorySeedOutcome> {
  return seedBlockOnce(settings, {
    alreadyConfigured: () => settings.effective().memory !== undefined,
    buildPatch: () => ({ memory: { enabled: true } }),
  });
}
