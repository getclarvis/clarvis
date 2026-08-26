/**
 * Where a model provider's API key comes from, and the TUI-side cache over it.
 *
 * @remarks Named `provider-secrets` rather than `keys` deliberately. As `keys.ts`
 * it sat one directory from `src/keys/`, the keyboard vocabulary, and appeared in
 * every keyword search for keyboard handling while having nothing to do with it —
 * it was even listed among the keyboard item's files. A "key" here is a
 * credential, never a keystroke.
 */
import type { SecretService } from "@clarvis/protocol";

/** Where a provider key is configured to come from: chosen automatically, forced to env, or forced to the keyfile. */
export type KeySource = "auto" | "env" | "keyfile";

/**
 * Resolves where a key's value actually comes from, given its configured
 * {@link KeySource} and where it is actually present.
 *
 * @remarks When `source` is `"auto"`, env takes precedence over the keyfile;
 *   a `source` pinned to one origin that turns out absent resolves to
 *   `"unset"` rather than silently falling back to the other.
 */
export function keyOrigin(
  source: KeySource,
  envPresent: boolean,
  filePresent: boolean,
): "env" | "keyfile" | "unset" {
  if (source === "env") return envPresent ? "env" : "unset";
  if (source === "keyfile") return filePresent ? "keyfile" : "unset";
  return envPresent ? "env" : filePresent ? "keyfile" : "unset";
}

/** A local cache of which provider secret names exist, backed by the kernel's {@link SecretService}. */
export interface KeysAdapter {
  has(name: string): boolean;
  set(name: string, value: string): Promise<void>;
  reload(): Promise<void>;
}

/** Builds a {@link KeysAdapter}, seeding its name cache with one `listNames()` call. */
export async function createKeysAdapter(secrets: SecretService): Promise<KeysAdapter> {
  const names = new Set<string>(await secrets.listNames());
  return {
    has: (name) => names.has(name),
    set: async (name, value) => {
      await secrets.set(name, value);
      names.add(name);
    },
    reload: async () => {
      const fresh = await secrets.listNames();
      names.clear();
      for (const n of fresh) names.add(n);
    },
  };
}
