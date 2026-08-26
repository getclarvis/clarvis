import type { Scope, SettingsAdapter } from "../adapters/settings.ts";

/** Why {@link seedBlockOnce} declined to write, and when. */
export type SeedSkipReason = "already-configured" | "no-settings-file" | "corrupt";

/**
 * What a {@link seedBlockOnce} call did: either it declined (with a reason)
 * or it wrote to a scope, in which case the caller's own `T` fields (if any)
 * are merged into the outcome.
 */
export type SeedOutcome<T extends Record<string, unknown>> =
  { seeded: false; reason: SeedSkipReason } | ({ seeded: true; scope: Scope } & T);

/**
 * The "seed a settings block once" guard sequence shared by every onboarding
 * seeder: already-configured, then corrupt-scope, then no-settings-file,
 * then a single write to the global scope.
 *
 * `seedMemoryBlock`, `seedPlansBlock` and `seedDefaultAllowlist` each
 * re-implemented this exact sequence; this is the one copy they now share.
 *
 * @param settings - the settings adapter; a successful write always targets
 *   the global scope, so the resulting policy is legible and attributable to
 *   a scope rather than merged in from an unnamed source.
 * @param config - `alreadyConfigured` decides the first refusal — it is the
 *   caller's job to treat its own "off"/"empty" sentinel as configured, so an
 *   explicit opt-out is never re-seeded; `buildPatch` builds the write's
 *   payload once the guard sequence clears; `additionalOutcome` merges extra
 *   fields (e.g. a written count) into a successful outcome.
 * @returns why nothing was written, or the scope written to plus any
 *   `additionalOutcome` fields.
 *
 * @remarks
 * Seeding refuses to run when no `settings.json` exists in either scope —
 * creating that file is the onboarding doctor's `config` gate's job, not this
 * one's — and when either scope is corrupt, since the write would fail
 * anyway. Those are the only two refusals possible once a caller's own
 * `alreadyConfigured` has returned false.
 */
export async function seedBlockOnce<T extends Record<string, unknown> = Record<string, unknown>>(
  settings: SettingsAdapter,
  config: {
    alreadyConfigured(): boolean;
    buildPatch(): Record<string, unknown>;
    additionalOutcome?: T;
  },
): Promise<SeedOutcome<T>> {
  if (config.alreadyConfigured()) return { seeded: false, reason: "already-configured" };
  const scopes: Scope[] = ["global", "workspace"];
  if (scopes.some((scope) => settings.corrupt(scope))) return { seeded: false, reason: "corrupt" };
  if (!scopes.some((scope) => settings.read(scope)))
    return { seeded: false, reason: "no-settings-file" };
  await settings.write("global", config.buildPatch());
  return { seeded: true, scope: "global", ...(config.additionalOutcome ?? ({} as T)) };
}
