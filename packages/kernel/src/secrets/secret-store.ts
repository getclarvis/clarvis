import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { globalPaths, writeFileAtomicSync } from "@clarvis/paths";
import type { SecretService } from "@clarvis/protocol";

/** A valid secret name: an environment-variable identifier (leading letter/underscore, then word chars). */
const ENV_VAR_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Schema of the on-disk `keys.json`: a map of {@link ENV_VAR_RE}-shaped names to non-empty string values. */
const keysFileSchema = z.record(z.string().regex(ENV_VAR_RE), z.string().min(1));

/** Result of reading the secrets file: validated values or a parse error with empty values. */
export interface SecretSnapshot {
  /** The validated name→value map; empty when the file is missing or fails validation. */
  values: Record<string, string>;
  /** A human-readable parse/validation error; absent when the read succeeded. */
  error?: string;
}

/**
 * Low-level keyed secret storage (typically `keys.json`).
 * Name keys must look like environment variable identifiers.
 */
export interface SecretStore {
  /** @returns the absolute path of the backing secrets file. */
  path(): string;
  /** @returns the current {@link SecretSnapshot} — values, or empty values plus an `error` on a bad file. */
  read(): SecretSnapshot;
  /**
   * Store (or overwrite) one secret.
   *
   * @param name - the secret name; must match {@link ENV_VAR_RE}.
   * @param value - the non-empty secret value.
   * @throws Error when `name` is invalid, `value` is empty, or the file is
   *   currently unparseable.
   */
  set(name: string, value: string): void;
  /**
   * Remove one secret; a no-op when it is absent.
   *
   * @param name - the secret name to delete.
   * @throws Error when the file is currently unparseable.
   */
  delete(name: string): void;
}

/** Options for {@link createFileSecretStore}. */
export interface FileSecretStoreOptions {
  /** Directory containing `keys.json` (defaults to the Clarvis global dir). */
  dir?: string;
}

/** Condense a {@link z.ZodError} to a one-line `path: message` summary for the {@link SecretSnapshot.error}. */
function issueSummary(err: z.ZodError): string {
  const first = err.issues[0];
  if (first === undefined) return "invalid keys file";
  const path = first.path.join(".");
  return path ? `${path}: ${first.message}` : first.message;
}

/**
 * Build a file-backed {@link SecretStore} over `keys.json`, writing atomically
 * with restrictive permissions and refusing mutations while the file fails
 * schema validation.
 *
 * @param opts - the containing directory; defaults to the Clarvis global dir.
 *   See {@link FileSecretStoreOptions}.
 * @returns a {@link SecretStore} that reads tolerantly (a missing or invalid file
 *   yields empty values, the latter with an `error`) and writes via tmp +
 *   `rename` with dirs `0o700` / file `0o600`.
 * @remarks {@link SecretStore.set} and {@link SecretStore.delete} both refuse to
 *   run when the current file is unparseable, so a hand-corrupted `keys.json` must
 *   be fixed by hand rather than being silently overwritten.
 */
export function createFileSecretStore(opts: FileSecretStoreOptions = {}): SecretStore {
  const file = globalPaths(opts.dir).keysFile;

  const read = (): SecretSnapshot => {
    if (!existsSync(file)) return { values: {} };
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      return { values: {}, error: `invalid JSON: ${e instanceof Error ? e.message : String(e)}` };
    }
    const parsed = keysFileSchema.safeParse(raw);
    return parsed.success
      ? { values: parsed.data }
      : { values: {}, error: issueSummary(parsed.error) };
  };

  /**
   * Persist the secret set atomically, owner-readable only.
   *
   * @remarks
   * **The mode bits do not confine anything on Windows.** `0o700`/`0o600` map
   * only onto the read-only attribute there, so provider API keys written on a
   * Windows host are readable by any process running as that user - which is the
   * same trust boundary the file's directory already sits behind, but a weaker
   * guarantee than the POSIX one. Tightening it would take an explicit ACL, which
   * is deliberately out of scope; recorded here so the difference is a known
   * divergence rather than an assumption that happens to be false.
   */
  const writeAll = (values: Record<string, string>): void => {
    writeFileAtomicSync(file, `${JSON.stringify(values, null, 2)}\n`);
  };

  return {
    path: () => file,
    read,
    set: (name, value) => {
      if (!ENV_VAR_RE.test(name)) throw new Error(`invalid env var name: ${name}`);
      if (!value) throw new Error("empty key value");
      const cur = read();
      if (cur.error) throw new Error(`${file} is invalid (${cur.error}) — fix it by hand first`);
      writeAll({ ...cur.values, [name]: value });
    },
    delete: (name) => {
      const cur = read();
      if (cur.error) throw new Error(`${file} is invalid (${cur.error}) — fix it by hand first`);
      if (!(name in cur.values)) return;
      const { [name]: _drop, ...rest } = cur.values;
      writeAll(rest);
    },
  };
}

/**
 * Adapt a {@link SecretStore} to the protocol {@link SecretService}, exposing only
 * names — secret values never cross this boundary.
 *
 * @param store - the backing secret store.
 * @returns a {@link SecretService} that lists names and sets/deletes secrets.
 */
export function createSecretService(store: SecretStore): SecretService {
  return {
    /**
     * List the stored secret names.
     *
     * @returns the names; empty when the file is missing or currently invalid.
     */
    async listNames(): Promise<string[]> {
      return Object.keys(store.read().values);
    },
    /**
     * Store (or overwrite) one secret.
     *
     * @param name - the secret name; must match {@link ENV_VAR_RE}.
     * @param value - the non-empty secret value.
     * @throws Error when `name`/`value` is invalid or the file is unparseable.
     */
    async set(name: string, value: string): Promise<void> {
      store.set(name, value);
    },
    /**
     * Remove one secret; a no-op when it is absent.
     *
     * @param name - the secret name to delete.
     * @throws Error when the file is currently unparseable.
     */
    async delete(name: string): Promise<void> {
      store.delete(name);
    },
  };
}
