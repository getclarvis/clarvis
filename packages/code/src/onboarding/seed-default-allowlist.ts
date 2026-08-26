import { defaultAllowedCommands } from "../adapters/command-policy.ts";
import type { Scope, SettingsAdapter } from "../adapters/settings.ts";
import { seedBlockOnce } from "./seed-block-once.ts";

/** What {@link seedDefaultAllowlist} did, so the caller can decide whether to
 * tell the user and re-run the doctor gates. */
export type AllowlistSeedOutcome =
  | {
      seeded: false;
      reason: "already-configured" | "no-settings-file" | "corrupt";
    }
  | { seeded: true; scope: Scope; count: number };

/**
 * Give a host a starter command allow list the first time it is used.
 *
 * Every command is analyzed against the host's shell dialect, and anything the
 * analyzer cannot decide statically — or that matches no allow list entry —
 * becomes an approval prompt. With the guard on by default and no starting allow
 * list that means confirming `git status` by hand, which trains the user to
 * approve reflexively: the opposite of what the prompt is for.
 *
 * Writing the list once, into the **global** scope, keeps the policy the user's:
 * it is visible in settings, attributable to a scope, and editable. Compiling it
 * into the guard instead would make it an invisible default nobody could audit.
 *
 * @param settings - the settings adapter; the list goes to the global scope.
 * @param platform - host platform, choosing the dialect's list; injectable for tests.
 * @returns what happened, so the caller notifies only on a real write.
 *
 * @remarks
 * Idempotent: any existing `allowed_commands`, including an empty array, counts
 * as configured and is never overwritten — an empty list is a deliberate "ask me
 * about everything", not an absent setting. Like the planning seed, this refuses
 * to run when no `settings.json` exists in either scope (creating that file is
 * the doctor's job) or when either scope is corrupt.
 *
 * The two scopes it reads are deliberately different. Whether seeding is needed
 * is decided from the *effective* guard, so a list configured in any scope
 * counts. What is spread into the write is the *global* block, never the merged
 * one: `guard` is deliberately not a workspace-trust risk field, so a cloned
 * repository's `{"guard":{"mode":"off"}}` does reach `effective()`, and carrying
 * that into the global write would persist the repository's opt-out onto the
 * operator's machine for every workspace thereafter.
 */
export async function seedDefaultAllowlist(
  settings: SettingsAdapter,
  platform: NodeJS.Platform = process.platform,
): Promise<AllowlistSeedOutcome> {
  const guard = settings.read("global")?.guard;
  const allowed = defaultAllowedCommands(platform);
  return seedBlockOnce(settings, {
    alreadyConfigured: () => {
      const effectiveGuard = settings.effective().guard as
        { allowed_commands?: unknown } | undefined;
      return effectiveGuard?.allowed_commands !== undefined;
    },
    buildPatch: () => ({
      guard: { ...guard, type: "shell", allowed_commands: allowed },
    }),
    additionalOutcome: { count: allowed.length },
  });
}
