import type {
  ConfigChange,
  WorkspaceTrustVerdict,
  EnvironmentPluginRef,
  Scope,
  SettingsData,
  SettingsSource,
  Unsubscribe,
} from "@clarvis/protocol";
import { createHash } from "node:crypto";

/** Exact source bytes and the revision used for optimistic settings repair. */
export interface SettingsDocument {
  raw: string;
  revision: string;
}

/** SHA-256 revision of the exact settings source bytes. */
export function settingsDocumentRevision(raw: string | Uint8Array): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Raised when a settings compare-and-swap no longer matches its preview. */
export class SettingsRevisionConflictError extends Error {
  constructor(
    readonly expectedRevision: string | null,
    readonly actualRevision: string | null,
  ) {
    super("settings source changed since repair preview");
    this.name = "SettingsRevisionConflictError";
  }
}

/**
 * Persistence abstraction for settings, agent markdown, and workspace context
 * files that a {@link createConfigService | ConfigService} is layered over.
 *
 * @remarks Implementations may be in-memory
 *   ({@link createMemoryConfigStore | memory}, for tests and ephemeral kernels) or
 *   file-backed ({@link createFileConfigStore | file}). Methods are synchronous:
 *   the store owns disk/memory I/O, and the service wraps it in the async
 *   protocol surface. Validation of settings and agent frontmatter is the
 *   service's job, not the store's.
 */
export interface ConfigStore {
  /** Read the merged + per-scope settings snapshot. */
  readSettings(): SettingsSnapshot;
  /** Read one settings file exactly as stored, or `null` when it is absent. */
  readSettingsDocument(scope: Scope): SettingsDocument | null;
  /**
   * Replace one settings file under the store's write lock when its exact-byte
   * revision still matches `expectedRevision`.
   *
   * @remarks `repair` runs only after the comparison and while the lock is held;
   * throwing abandons the write. Implementations raise
   * {@link SettingsRevisionConflictError} on a missing or changed source.
   */
  compareAndSwapSettingsDocument(
    scope: Scope,
    expectedRevision: string,
    repair: (raw: string) => SettingsData,
  ): SettingsSnapshot;
  /**
   * Persist one scope's settings and return the refreshed snapshot.
   *
   * @param scope - the scope written (`global` or `workspace`).
   * @param data - the full settings object for that scope (not a patch).
   * @returns the recomputed {@link SettingsSnapshot} reflecting the write.
   */
  writeSettings(scope: Scope, data: SettingsData): SettingsSnapshot;
  /**
   * Read one scope's settings, hand them to `mutate`, and persist the result as
   * a single indivisible step.
   *
   * @param scope - the scope to update (`global` or `workspace`).
   * @param mutate - receives the scope's settings as they sit on disk *now* and
   *   returns the full replacement; it may throw to abandon the update, in which
   *   case nothing is written.
   * @returns the recomputed {@link SettingsSnapshot} reflecting the write.
   * @remarks Required because read-merge-write through
   *   {@link ConfigStore.readSettings | readSettings} +
   *   {@link ConfigStore.writeSettings | writeSettings} is only indivisible
   *   *within* one process: the two calls are synchronous, so nothing interleaves
   *   between them, but a second process editing the same file loses whichever
   *   update lands first. A file-backed store therefore serialises this across
   *   processes; an in-process store implements the same compare-and-swap
   *   contract without a filesystem lock. Keeping this mandatory prevents a
   *   new store from silently weakening the service's concurrency guarantee.
   */
  mutateSettings(
    scope: Scope,
    expectedRevision: string | null,
    mutate: (current: SettingsData) => SettingsData,
  ): SettingsSnapshot;

  /**
   * Every agent a host can see: shipped, file-backed and plugin-shipped.
   *
   * @remarks A name Clarvis ships appears **once**, already resolved through
   *   {@link resolveEffectiveAgent} — the record that will actually run, with
   *   its {@link AgentRecord.overlay} saying what a config file did to it. Every
   *   other name appears once per scope that defines it, so a cross-scope
   *   duplicate is still visible as the two records it is.
   */
  listAgents(): AgentRecord[];
  /**
   * Read one agent as stored in one layer, without resolving anything.
   *
   * @param scope - a config scope, or `"builtin"` for the agent as Clarvis
   *   ships it, ignoring any file that overlays it.
   * @returns the parsed {@link AgentRecord}, or `null` when that layer has no
   *   such agent.
   * @remarks Deliberately layer-precise rather than effective: an editor must
   *   open the bytes the user wrote, and the cross-scope conflict check must be
   *   able to ask whether a *file* exists. Use
   *   {@link ConfigStore.readEffectiveAgent} for what a run would get.
   */
  readAgent(scope: Scope | "builtin", name: string): AgentRecord | null;
  /**
   * Read the agent a run would enter for `name`, resolved across every layer.
   *
   * @returns the effective {@link AgentRecord}, or `null` when no layer defines
   *   `name`.
   */
  readEffectiveAgent(name: string): AgentRecord | null;
  /**
   * Create or overwrite an agent document.
   *
   * @returns the {@link AgentRecord} as re-parsed from what was written.
   */
  writeAgent(scope: Scope, name: string, input: AgentInput): AgentRecord;
  /** Remove an agent document; a no-op when it does not exist. */
  deleteAgent(scope: Scope, name: string): void;

  /**
   * Read the context preamble for a scope.
   *
   * @returns the {@link ContextRecord}, or `null` when the scope has none.
   */
  readContext(scope: Scope): ContextRecord | null;

  /**
   * Record or clear approval of this workspace's executable surface.
   *
   * @param approve - `true` to approve the current surface, `false` to revoke.
   * @returns the recomputed {@link SettingsSnapshot}.
   * @remarks Omitted by stores with no notion of workspace trust (the in-memory
   *   one); a service treats its absence as "nothing to approve".
   */
  setWorkspaceTrust?(approve: boolean): SettingsSnapshot;

  /** The workspace trust store's parse error, or `null` when readable. */
  workspaceTrustError?(): string | null;

  /**
   * Subscribe to config mutations; omit when the store is static.
   *
   * @param listener - invoked with each {@link ConfigChange}.
   * @returns an {@link Unsubscribe} that detaches the listener.
   */
  watch?(listener: (change: ConfigChange) => void): Unsubscribe;
}

/**
 * Merged settings view with per-scope layers and source metadata — the store-side
 * shape the service returns to clients as a protocol `SettingsView`.
 */
export interface SettingsSnapshot {
  /** Effective settings after the plugin ← global ← workspace merge. */
  merged: SettingsData;
  /** Raw per-scope contents, unmerged, as they sit on disk. */
  scopes: Partial<Record<Scope, SettingsData>>;
  /** Provenance (path/exists/parse-error) of each scope layer. */
  sources: SettingsSource[];
  /**
   * Risky workspace-scope fields present on disk but withheld from
   * {@link SettingsSnapshot.merged | merged} — a repository may not execute code
   * on its own authority. Absent when nothing was withheld.
   *
   * @remarks {@link SettingsSnapshot.scopes | scopes} still reports the raw file
   *   as it sits on disk, so a UI can show what the repository asked for
   *   alongside what was refused.
   */
  withheld_workspace_fields?: readonly string[];
  /**
   * Whether this workspace's executable surface is approved: `inert` when it
   * declares none, otherwise `trusted` / `unapproved` / `changed`.
   */
  workspace_trust?: WorkspaceTrustVerdict;
  /** Exact plugin installations selected by the resolved extension Environment. */
  active_plugins?: readonly EnvironmentPluginRef[];
}

/**
 * How a config-scope file relates to the agent Clarvis ships under the same name.
 *
 * @remarks Present on an {@link AgentRecord} exactly when Clarvis ships an agent
 *   by that name *and* a file of that name exists in some config scope. Its job
 *   is to make the overlay visible: a merge that reports nothing is
 *   indistinguishable from a builtin nobody touched, and a *refused* overlay
 *   that reports nothing is the worse case still — the user edited a file and
 *   Clarvis quietly ran something else.
 */
export interface AgentOverlay {
  /** The config scope holding the file, whether or not it was applied. */
  scope: Scope;
  /** Whether the file's fields are in effect, or were refused. */
  status: "applied" | "rejected";
  /** Why the file was refused. Present exactly when `status` is `"rejected"`. */
  reason?: string;
  /**
   * Other config scopes that also hold a file of this name.
   *
   * @remarks A name may legitimately exist in only one scope — `writeAgent`
   *   refuses to create the second — but nothing stops a user dropping the file
   *   in both by hand. For a non-builtin name that shows up as two records in
   *   `listAgents`; a builtin name yields one effective record, so the loser
   *   would otherwise vanish silently instead of being reported as the conflict
   *   it is.
   */
  shadowed?: readonly Scope[];
}

/**
 * Parsed agent definition as stored by a {@link ConfigStore}.
 *
 * @remarks `scope` widens past the `global`/`workspace` file scopes twice over:
 *   to `"plugin"` for a plugin-shipped agent, and to `"builtin"` for one Clarvis
 *   ships. It names the layer whose content is *in effect*, so an agent shipped
 *   by Clarvis and overlaid from a file reports the file's scope — but one whose
 *   overlay was refused reports `"builtin"`, because that is what will run.
 *   `model`/`description`/`plugin` are lifted out of {@link frontmatter} as a
 *   convenience projection.
 */
export interface AgentRecord {
  name: string;
  scope: Scope | "plugin" | "builtin";
  /** The agent's parsed YAML frontmatter. */
  frontmatter: Record<string, unknown>;
  /** The markdown body below the frontmatter (the agent prompt). */
  body: string;
  /** `model` lifted from the frontmatter, when present. */
  model?: string;
  /** `description` lifted from the frontmatter, when present. */
  description?: string;
  /** Owning plugin name, for a plugin-shipped agent. */
  plugin?: string;
  /**
   * Why this agent's frontmatter could not be parsed, when it could not be.
   *
   * @remarks The runtime keeps reading these files leniently — a profile with
   * broken YAML still loads, with empty frontmatter, so a workspace is never
   * bricked by one bad file. That tolerance was silent, and silence is the
   * defect: an agent whose YAML failed came back with **zero grants**, demoted
   * from Lead to Sub-agent, while the agent list still showed it runnable and
   * Doctor still reported ready. This field is the channel that makes the
   * tolerance visible; it is populated by a strict re-parse whose only job is
   * to produce this message.
   */
  malformed?: string;
  /**
   * What a config file did to the agent Clarvis ships under this name.
   *
   * @remarks Present only for a shipped agent that some scope holds a file for.
   *   See {@link AgentOverlay}.
   */
  overlay?: AgentOverlay;
}

/** Payload for creating or updating an agent document. */
export interface AgentInput {
  /** Frontmatter to serialize above the body. */
  frontmatter: Record<string, unknown>;
  /** Markdown body (the agent prompt). */
  body: string;
}

/**
 * Workspace or global context markdown (`CLARVIS.md` / `AGENTS.md`).
 *
 * @remarks `path` is the on-disk location for a file-backed store and absent for
 *   an in-memory one.
 */
export interface ContextRecord {
  scope: Scope;
  path?: string;
  content: string;
}
