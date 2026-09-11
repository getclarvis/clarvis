import { kernelCapabilityRegistry, kernelSettingsSchema } from "./capability-registry.ts";
import { createRateLimiter, NOOP_LOGGER, type Logger, type Sampler } from "@clarvis/capability";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import {
  acquireLocalLeaseSync,
  CONTEXT_FILENAMES,
  ensureWorkspaceDir,
  globalPaths,
  globalRoot,
  type LocalLeaseSync,
  workspacePaths,
  writeFileAtomicSync,
} from "@clarvis/paths";
import { mergeSettings, splitAgentFrontmatter, type SettingsScope } from "@clarvis/loop/host";
import type { ExtensionProfilePluginRef, WorkspaceTrustVerdict } from "@clarvis/protocol";
import type { Scope, SettingsData, SettingsSource } from "@clarvis/protocol";
import {
  SettingsRevisionConflictError,
  settingsDocumentRevision,
  type AgentInput,
  type AgentRecord,
  type ConfigStore,
  type ContextRecord,
  type SettingsSnapshot,
} from "./config-store.ts";
import type { PluginContributions } from "../plugins/plugin-contributions.ts";
import { builtinAgentRecord, resolveEffectiveAgent } from "./agent-overlay.ts";
import { BUILTIN_AGENT_NAMES, isBuiltinAgent, readBuiltinAgent } from "./builtin-agents/index.ts";
import {
  canonicalWorkspaceKey,
  readWorkspaceTrustFile,
  stripWorkspaceRiskFields,
  stripWorkspaceSubscriptionProviders,
  workspaceTrustFingerprint,
  workspaceTrustVerdict,
  writeWorkspaceTrust,
} from "./workspace-trust.ts";

/**
 * Path configuration for a file-backed config store.
 *
 * @remarks The global scope defaults to the resolved Clarvis dir; the workspace
 *   scope exists only when `workspaceRoot` (or an explicit `workspaceConfigDir`)
 *   is given — otherwise writes to `workspace` reject as unconfigured (see
 *   {@link createFileConfigStore}).
 */
export interface FileConfigStoreOptions {
  /** Workspace root; its `.clarvis` becomes the workspace config dir and its root the context base. */
  workspaceRoot?: string;
  /** Global config dir; defaults to the resolved Clarvis dir when omitted. */
  globalDir?: string;
  /** Explicit workspace config dir, overriding the `workspaceRoot`/`.clarvis` default. */
  workspaceConfigDir?: string;
  /**
   * Enabled plugins fold their contributions in here: settings
   * fragments (hooks / mcpServers / capability blocks) into the merge, and
   * their `<plugin>:<agent>` files into agent listing/resolution. Omitted in
   * tests and non-plugin hosts.
   */
  plugins?: PluginContributions;
  /** Host-owned Extension Profile resolver; the loop never sees this concept. */
  extensionProfile?: {
    resolvePlugins(
      enabledPlugins: readonly ExtensionProfilePluginRef[],
      trust: WorkspaceTrustVerdict,
    ): readonly ExtensionProfilePluginRef[];
    workspaceTrustSurface(options?: { refresh?: boolean }): unknown;
    assertWorkspaceTrustTransitionAllowed?(): void;
  };
  /**
   * Where a rejected or discarded configuration document is reported.
   *
   * @remarks Until this existed the diagnostic reached exactly one place — a
   * {@link SettingsSource.error} a client had to ask for — so a `settings.json`
   * this schema refuses looked, to everything that did not call
   * `config.getSettings()`, like a workspace with no settings at all.
   */
  logger?: Logger;
}

/**
 * Report a configuration document this schema refuses.
 *
 * @param logger - the store's logger.
 * @param admit - rate limiter; the same bad file is read on every snapshot, so
 *   the fact is worth saying once a minute and worthless said continuously.
 * @param scope - which scope the document belongs to.
 * @param path - the file that was refused.
 * @param at - the failing key path, or a bracketed pseudo-location.
 * @param message - why it failed.
 */
function reportRejected(
  logger: Logger,
  admit: Sampler,
  scope: Scope,
  path: string,
  at: string,
  message: string,
): void {
  if (!admit(`${scope}\0${path}\0${at}\0${message}`)) return;
  logger.error(
    { event: "kernel.config.rejected", scope, path, at, message, schema: "kernelSettingsSchema" },
    "a settings file was rejected and contributes nothing to the merge; the scope behaves as if it were absent",
  );
}

/**
 * Report a document a mutation path silently treated as empty.
 *
 * @param logger - the store's logger.
 * @param scope - which scope the document belongs to.
 * @param path - the file that was discarded.
 * @param reason - `json` when it did not parse, `schema` when it did not validate.
 * @remarks Worse than a rejected read, because this one is about to be
 *   *overwritten*: the mutation folds onto `{}`, so every key the file held is
 *   gone the moment the write lands.
 */
function reportDiscarded(
  logger: Logger,
  scope: Scope,
  path: string,
  reason: "json" | "schema",
): void {
  logger.warn(
    { event: "kernel.config.document_discarded", scope, path, reason },
    "an unreadable settings document was treated as empty by a mutation; its existing keys will not survive the write",
  );
}

/**
 * Report an agents directory that exists but could not be enumerated.
 *
 * @param logger - the store's logger.
 * @param scope - which scope the directory belongs to.
 * @param dir - the directory that failed.
 * @param cause - the sanitized failure message.
 * @remarks Without this, an unreadable directory and an empty one are the same
 *   observable outcome — no agents — and a permissions mistake looks like a
 *   workspace that simply ships none.
 */
function reportAgentsUnreadable(logger: Logger, scope: Scope, dir: string, cause: string): void {
  logger.warn(
    { event: "kernel.config.agents_unreadable", scope, dir, cause },
    "an agents directory could not be enumerated; this scope contributes no agents",
  );
}

/** The two on-disk config scopes, in merge order (global first, workspace last-wins). */
const SCOPES: readonly Scope[] = ["global", "workspace"];

/**
 * How old a settings lease must be before recovery may inspect its holder.
 *
 * @remarks Age alone never authorizes reclaiming a valid lease: the shared
 * primitive additionally proves that its same-host process is dead. This grace
 * bounds recovery of malformed legacy records and dead holders without
 * declaring a slow live writer abandoned.
 */
const SETTINGS_LOCK_STALE_MS = 10_000;

/**
 * How long a contender keeps retrying before giving up on the lock.
 *
 * @remarks Two orders of magnitude below {@link SETTINGS_LOCK_STALE_MS}, and
 * that ordering is the point: an ordinary contender must get its answer — the
 * write, or a clean failure — long before its own wait could be mistaken for an
 * abandoned lease. It is also a *foreground* wait, since a settings write is a
 * person pressing a key, so the budget is what a UI can hold without appearing
 * stuck rather than what a queue needs to drain. Unlike a plan write, settings
 * have one writer at a time in practice, so there is no queue to size against.
 */
const SETTINGS_LOCK_WAIT_MS = 2_000;

/**
 * Pause between acquisition attempts.
 *
 * @remarks The granularity of the wait above: it is the latency this contender
 * adds after the holder releases, so it is set an order of magnitude below the
 * fsync-ed write it is waiting on. Four hundred attempts then carry the budget;
 * the retry interval is the number with meaning, and the attempt count follows
 * from it.
 */
const SETTINGS_LOCK_RETRY_MS = 5;

/**
 * Hard read/write bounds for user-authored configuration documents.
 *
 * @remarks Every one of these bounds a file a *person* wrote, which is what sets
 * their scale: they are not tuned against a workload, they are set where a
 * hand-authored document stops being plausible, so that a truncated read, a
 * generated file or a mistaken path is refused rather than loaded. None of them
 * is reachable by ordinary use, and each has a floor it must clear:
 *
 * - `MAX_SETTINGS_DOCUMENT_BYTES` must hold the merged blocks of every
 *   registered capability plus an operator's provider catalog.
 * - `MAX_AGENT_DOCUMENT_BYTES` must hold the longest shipped agent prompt with
 *   room to spare — `admiral` is the largest at roughly 27 KB, and an operator's
 *   overlay may be longer still.
 * - `MAX_AGENT_DOCUMENTS_PER_SCOPE` must hold the shipped fleet several times
 *   over, since a scope holds overlays *and* the operator's own agents.
 * - `MAX_AGENT_DIRECTORY_ENTRIES` is larger than that on purpose: the directory
 *   may hold non-agent files, and the scan must be bounded before the documents
 *   are counted.
 * - `MAX_AGENT_DOCUMENTS_TOTAL_BYTES` is the aggregate the per-document bound
 *   cannot enforce, and sits below the per-document bound times the per-scope
 *   count — so many mid-sized agents are refused as a set, not one at a time.
 */
export const MAX_SETTINGS_DOCUMENT_BYTES = 2 * 1024 * 1024;
export const MAX_AGENT_DOCUMENT_BYTES = 256 * 1024;
export const MAX_AGENT_DOCUMENTS_PER_SCOPE = 64;
const MAX_AGENT_DIRECTORY_ENTRIES = 256;
const MAX_AGENT_DOCUMENTS_TOTAL_BYTES = 8 * 1024 * 1024;
export const MAX_CONTEXT_DOCUMENT_BYTES = 2 * 1024 * 1024;

class ConfigResourceLimitError extends Error {
  constructor(path: string, label: string, maxBytes: number) {
    super(`${label} '${path}' exceeds the ${String(maxBytes)}-byte resource limit`);
    this.name = "ConfigResourceLimitError";
  }
}

/** Read through a descriptor into at most `maxBytes + 1`, closing size-race gaps. */
function readBoundedBytes(path: string, maxBytes: number, label: string): Buffer {
  const fd = openSync(path, "r");
  try {
    const initial = fstatSync(fd);
    if (initial.size > maxBytes) throw new ConfigResourceLimitError(path, label, maxBytes);
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let total = 0;
    while (total < buffer.length) {
      const read = readSync(fd, buffer, total, buffer.length - total, null);
      if (read === 0) break;
      total += read;
    }
    if (total > maxBytes) throw new ConfigResourceLimitError(path, label, maxBytes);
    return buffer.subarray(0, total);
  } finally {
    closeSync(fd);
  }
}

function readBoundedText(path: string, maxBytes: number, label: string): string {
  return readBoundedBytes(path, maxBytes, label).toString("utf8");
}

interface AgentDirectoryPage {
  names: string[];
  overflow: boolean;
}

/** Enumerate only a finite prefix; extra files never enter the executable surface. */
function boundedAgentNames(dir: string, scope: Scope, logger: Logger): AgentDirectoryPage {
  const names: string[] = [];
  let examined = 0;
  let overflow = false;
  let handle: ReturnType<typeof opendirSync> | undefined;
  try {
    handle = opendirSync(dir);
    for (;;) {
      const entry = handle.readSync();
      if (entry === null) break;
      examined += 1;
      if (examined > MAX_AGENT_DIRECTORY_ENTRIES) {
        overflow = true;
        break;
      }
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      if (names.length >= MAX_AGENT_DOCUMENTS_PER_SCOPE) {
        overflow = true;
        break;
      }
      names.push(entry.name);
    }
  } catch (error) {
    reportAgentsUnreadable(
      logger,
      scope,
      dir,
      error instanceof Error ? error.message : String(error),
    );
    return { names: [], overflow: false };
  } finally {
    try {
      handle?.closeSync();
    } catch {
      void 0;
    }
  }
  return { names, overflow };
}

/**
 * Block the thread for `ms`, so a synchronous {@link ConfigStore} method can wait
 * for a contended lock without an `await` its callers cannot make.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Whether `err` is a filesystem error carrying `code`. */
function hasErrnoCode(err: unknown, code: string): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === code;
}

/**
 * Take the local settings lease, waiting boundedly for a live holder.
 *
 * @param lockPath - the lock file to create.
 * @returns an inode- and token-bound lease whose release cannot unlink an ABA
 *   successor at the same path.
 * @throws an `Error` when the lock stays held past {@link SETTINGS_LOCK_WAIT_MS}.
 * @remarks This is local-filesystem, same-host coordination. It does not claim
 * distributed locking over NFS or another multi-host shared filesystem.
 */
function acquireSettingsLock(lockPath: string): LocalLeaseSync {
  const deadline = Date.now() + SETTINGS_LOCK_WAIT_MS;
  for (;;) {
    const lease = acquireLocalLeaseSync(lockPath, { staleMs: SETTINGS_LOCK_STALE_MS });
    if (lease !== null) return lease;
    if (Date.now() >= deadline) {
      throw new Error(`settings are locked by another process (${lockPath})`);
    }
    sleepSync(SETTINGS_LOCK_RETRY_MS);
  }
}

/**
 * Build a file-backed {@link ConfigStore} over `settings.json`, `agents/*.md`, and
 * context files (`CLARVIS.md` / `AGENTS.md`) under the global and workspace roots.
 *
 * Settings writes are atomic (tmp + `rename`, dirs 0700, files 0600); agent files
 * are written as YAML-frontmatter-wrapped markdown. When
 * {@link FileConfigStoreOptions.plugins | plugins} is supplied, enabled
 * plugins fold their settings fragments into the merge and their `<plugin>:<agent>`
 * files into agent listing and resolution.
 *
 * @param opts - path configuration and optional plugin contributions.
 * @returns a {@link ConfigStore}; it has no `watch`, so the service treats it as
 *   static. Reads of a malformed `settings.json` do not throw — the scope's parse
 *   error surfaces on its {@link SettingsSource}.
 * @throws (from `writeSettings`/`writeAgent`/`deleteAgent`) an `Error` when the
 *   targeted scope is not configured (e.g. a `workspace` write with no workspace root).
 */
export function createFileConfigStore(opts: FileConfigStoreOptions): ConfigStore {
  const logger = opts.logger ?? NOOP_LOGGER;
  const admitRejection = createRateLimiter();
  const globalDir = opts.globalDir ?? globalRoot();
  const workspaceConfigDir =
    opts.workspaceConfigDir ??
    (opts.workspaceRoot !== undefined ? workspacePaths(opts.workspaceRoot).clarvisDir : undefined);
  const global = globalPaths(globalDir);
  const settingsPath = (scope: Scope): string | undefined =>
    scope === "global"
      ? global.settingsFile
      : workspaceConfigDir === undefined
        ? undefined
        : join(workspaceConfigDir, "settings.json");
  const agentsDir = (scope: Scope): string | undefined =>
    scope === "global"
      ? global.agentsDir
      : workspaceConfigDir === undefined
        ? undefined
        : join(workspaceConfigDir, "agents");
  const agentPath = (scope: Scope, name: string): string | undefined => {
    if (scope === "global") return global.agentFile(name);
    const d = agentsDir(scope);
    return d === undefined ? undefined : join(d, `${name}.md`);
  };
  const contextCandidates = (scope: Scope): readonly string[] | undefined =>
    scope === "global"
      ? global.contextCandidates
      : opts.workspaceRoot === undefined
        ? undefined
        : CONTEXT_FILENAMES.map((name) => join(opts.workspaceRoot!, name));

  /** Write via a tmp file + `rename` (dirs 0700, file 0600) so readers never see a torn file. */
  const writeAtomic = (scope: Scope, path: string, content: string): void => {
    const settings = path === settingsPath(scope);
    const maxBytes = settings ? MAX_SETTINGS_DOCUMENT_BYTES : MAX_AGENT_DOCUMENT_BYTES;
    if (Buffer.byteLength(content, "utf8") > maxBytes)
      throw new ConfigResourceLimitError(
        path,
        settings ? "settings document" : "agent document",
        maxBytes,
      );
    if (scope === "workspace" && opts.workspaceRoot !== undefined)
      ensureWorkspaceDir(opts.workspaceRoot);
    writeFileAtomicSync(path, content);
  };

  /** Read one settings file as decoded source while hashing its exact bytes. */
  const readSettingsDocument = (scope: Scope) => {
    const path = settingsPath(scope);
    if (path === undefined) return null;
    try {
      const bytes = readBoundedBytes(path, MAX_SETTINGS_DOCUMENT_BYTES, "settings document");
      return { raw: bytes.toString("utf8"), revision: settingsDocumentRevision(bytes) };
    } catch (err) {
      if (hasErrnoCode(err, "ENOENT")) return null;
      throw err;
    }
  };

  /**
   * Read and validate one scope's `settings.json`.
   *
   * @returns an empty object when the scope is unconfigured or the file is absent;
   *   `{ value }` on a clean parse; `{ error }` when the file exists but fails
   *   {@link kernelSettingsSchema}.
   */
  const readScopeSettings = (
    scope: Scope,
  ): {
    document: ReturnType<typeof readSettingsDocument>;
    value?: SettingsData;
    error?: string;
    exists?: boolean;
  } => {
    const p = settingsPath(scope);
    let document: ReturnType<typeof readSettingsDocument>;
    try {
      document = readSettingsDocument(scope);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reportRejected(logger, admitRejection, scope, p ?? "", "(read)", message);
      return {
        document: null,
        exists: p !== undefined && existsSync(p),
        error: message,
      };
    }
    if (p === undefined || document === null) return { document };
    let json: unknown;
    try {
      json = JSON.parse(document.raw);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      reportRejected(logger, admitRejection, scope, p, "(json)", detail);
      return { document, error: `invalid JSON in ${p}: ${detail}` };
    }
    const parsed = kernelSettingsSchema.safeParse(json);
    if (parsed.success) return { document, value: parsed.data };
    const issue = parsed.error.issues[0];
    if (issue === undefined) {
      reportRejected(logger, admitRejection, scope, p, "(root)", "validation failed");
      return { document, error: `invalid ${p}: validation failed` };
    }
    const at = issue.path.length > 0 ? issue.path.map(String).join(".") : "(root)";
    reportRejected(logger, admitRejection, scope, p, at, issue.message);
    return { document, error: `invalid ${p}: ${at}: ${issue.message}` };
  };

  /**
   * The workspace's agent files as raw `{ name, content }` pairs, for the trust
   * fingerprint.
   *
   * @returns one entry per `.md` under the workspace agents dir; empty when the
   *   directory is absent or unreadable.
   */
  const workspaceAgentFiles = (): { name: string; content: string }[] => {
    const dir = agentsDir("workspace");
    if (dir === undefined || !existsSync(dir)) return [];
    const page = boundedAgentNames(dir, "workspace", logger);
    const out: { name: string; content: string }[] = [];
    let totalBytes = 0;
    for (const name of page.names) {
      const path = join(dir, name);
      try {
        const content = readBoundedText(path, MAX_AGENT_DOCUMENT_BYTES, "agent document");
        totalBytes += Buffer.byteLength(content, "utf8");
        if (totalBytes > MAX_AGENT_DOCUMENTS_TOTAL_BYTES) {
          out.push({ name: "<resource-limit>", content: "aggregate agent bytes exceeded" });
          return out;
        }
        out.push({ name, content });
      } catch {
        // A withheld sentinel changes the trust fingerprint without retaining
        // the oversized source or accidentally approving an unread surface.
        out.push({ name, content: "<resource-limit>" });
      }
    }
    if (page.overflow)
      out.push({ name: "<resource-limit>", content: "agent directory entry limit exceeded" });
    return out;
  };

  /**
   * The trust store key for this workspace.
   *
   * @remarks Prefers the workspace root, falling back to the config dir so a
   *   store constructed with only `workspaceConfigDir` still has a stable,
   *   non-empty key rather than colliding with every other such store.
   */
  const trustKey = (): string =>
    canonicalWorkspaceKey(opts.workspaceRoot ?? workspaceConfigDir ?? "<no-workspace>");

  /**
   * Whether this workspace's executable surface has been approved.
   *
   * @returns the verdict, recomputed on every call from settings and workspace
   *   agents. The Extension Profile's extension surface is process-cached so ordinary
   *   reads never walk plugin files; an explicit approval refreshes that surface.
   * @remarks An unreadable trust store yields `unapproved`, never `trusted`: the
   *   failure mode of a corrupt approvals file must be "nothing is approved".
   */
  const workspaceVerdict = (
    settings: SettingsData | undefined,
    extensionSurface: unknown = opts.extensionProfile?.workspaceTrustSurface(),
  ): WorkspaceTrustVerdict => {
    const fingerprint = workspaceTrustFingerprint(
      settings,
      workspaceAgentFiles(),
      extensionSurface,
    );
    if (fingerprint === undefined) return { state: "inert" };
    const key = trustKey();
    return workspaceTrustVerdict(fingerprint, key, readWorkspaceTrustFile(globalDir).trust);
  };

  /** Whether the workspace layer may contribute its executable fields. */
  const workspaceTrusted = (settings: SettingsData | undefined): boolean => {
    const state = workspaceVerdict(settings).state;
    return state === "inert" || state === "trusted";
  };

  /**
   * Record or clear approval of the workspace surface as it stands right now.
   *
   * @param approve - `true` to approve the current fingerprint, `false` to revoke.
   */
  const approveCurrentSurface = (approve: boolean): void => {
    const fingerprint = workspaceTrustFingerprint(
      readScopeSettings("workspace").value,
      workspaceAgentFiles(),
      opts.extensionProfile?.workspaceTrustSurface({ refresh: true }),
    );
    if (fingerprint === undefined && approve) return;
    const key = trustKey();
    writeWorkspaceTrust(globalDir, key, approve ? fingerprint : undefined);
  };

  /**
   * Run an operator write against the workspace scope, carrying approval across
   * it when the workspace already had it.
   *
   * @param scope - the scope being written; anything but `workspace` is a no-op wrapper.
   * @param write - performs the write.
   * @remarks
   * Writing an agent or another authored workspace document through an
   * operator-authorized configuration surface is the operator deliberately
   * changing workspace configuration inside Clarvis, and
   * leaving their own edit withheld until they separately approved it would be
   * absurd. So the approval is re-recorded over the new surface — but **only if
   * the workspace was trusted or inert beforehand**. A repository sitting at
   * `unapproved` does not become approved because the operator changed one
   * unrelated setting inside it.
   *
   * What this deliberately does not cover is the case trust exists for: content
   * that arrived with a clone, or that an agent wrote into `.clarvis/` using its
   * file tools. Neither passes through this API, so neither can self-approve.
   *
   * A failure to record the carried approval is swallowed rather than thrown.
   * By that point the settings or agent file has already been written, so
   * rethrowing — which an unreadable `workspace-trust.json` would cause —
   * reports a failed save for a write that in fact landed, and the caller cannot
   * tell that from a no-op. The lost approval is recoverable by approving again;
   * a phantom failure is not. `workspaceTrustError()` still names the unreadable
   * store, and the surface stays withheld until it is fixed, so nothing becomes
   * silently trusted.
   */
  const withOperatorWrite = <T>(scope: Scope, write: () => T): T => {
    if (scope !== "workspace") return write();
    const carried = workspaceTrusted(readScopeSettings("workspace").value);
    const out = write();
    if (!carried) return out;
    try {
      approveCurrentSurface(true);
    } catch {
      /* see @remarks: the write already landed, so this must not throw */
    }
    return out;
  };

  const asEngine = (s: SettingsData): SettingsScope["settings"] =>
    s as unknown as SettingsScope["settings"];

  /**
   * Both operator scopes read once, with the workspace layer already gated on
   * this workspace's trust verdict.
   *
   * @returns each scope's raw read, the workspace strip result when one was
   *   applied (the snapshot reports its withheld field names), and the merge
   *   input in `global`-then-`workspace` order.
   * @remarks Built here rather than twice because {@link operatorEnabled} and
   *   {@link snapshot} assembled the same list from separate code — the same
   *   trust gate, the same {@link stripWorkspaceRiskFields}, the same order —
   *   with no test comparing them.
   */
  const operatorLayers = (): {
    global: ReturnType<typeof readScopeSettings>;
    workspace: ReturnType<typeof readScopeSettings>;
    gated: ReturnType<typeof stripWorkspaceRiskFields> | undefined;
    scopes: SettingsScope[];
  } => {
    const global = readScopeSettings("global");
    const workspace = readScopeSettings("workspace");
    const protectedProviderNames = new Set(
      (global.value?.providers ?? [])
        .filter((provider) => provider.kind === "openai-codex" || provider.kind === "xai-grok")
        .map((provider) => provider.name),
    );
    const permanentlyGated =
      workspace.value === undefined
        ? undefined
        : stripWorkspaceSubscriptionProviders(workspace.value, protectedProviderNames);
    const trustGated =
      permanentlyGated !== undefined && !workspaceTrusted(workspace.value)
        ? stripWorkspaceRiskFields(permanentlyGated.settings)
        : undefined;
    const gated =
      permanentlyGated === undefined
        ? undefined
        : {
            settings: trustGated?.settings ?? permanentlyGated.settings,
            withheld: [...new Set([...permanentlyGated.withheld, ...(trustGated?.withheld ?? [])])],
          };
    const workspaceForMerge = gated?.settings ?? workspace.value;
    const scopes: SettingsScope[] = [];
    if (global.value !== undefined)
      scopes.push({ origin: "operator", settings: asEngine(global.value) });
    if (workspaceForMerge !== undefined)
      scopes.push({ origin: "operator", settings: asEngine(workspaceForMerge) });
    return { global, workspace, gated, scopes };
  };

  /** Exact enabled plugin references from one merge of the operator layers. */
  const enabledPluginRefs = (scopes: SettingsScope[]): ExtensionProfilePluginRef[] => {
    const enabled = (mergeSettings(scopes, kernelCapabilityRegistry) as unknown as SettingsData)
      .enabledPlugins;
    return Array.isArray(enabled) ? (enabled as ExtensionProfilePluginRef[]) : [];
  };

  /** Winning declaration origin for each shallow-merged MCP namespace. */
  const mcpServerOrigins = (
    scopes: SettingsScope[],
  ): NonNullable<SettingsSnapshot["mcpServerOrigins"]> => {
    const origins: Record<string, SettingsScope["origin"]> = {};
    for (const scope of scopes) {
      for (const name of Object.keys(scope.settings.mcpServers ?? {})) origins[name] = scope.origin;
    }
    return origins;
  };

  /** The exact Extension Profile-qualified plugin refs allowed to contribute agents. */
  const operatorEnabled = (): readonly ExtensionProfilePluginRef[] =>
    snapshot().active_plugins ?? [];

  /**
   * Compute the current {@link SettingsSnapshot}: merge plugin fragments (for the
   * active Extension Profile plugins) under the operator `global` then `workspace` layers, expose
   * each scope's raw contents, and report per-scope {@link SettingsSource} provenance
   * (including any parse error).
   *
   * @remarks The workspace layer passes through {@link stripWorkspaceRiskFields}
   *   before it reaches the merge, so a cloned repository cannot contribute a
   *   field that executes. The withheld names are reported on the snapshot; the
   *   raw file still appears under `scopes.workspace`.
   */
  const snapshot = (): SettingsSnapshot => {
    const { global: g, workspace: w, gated, scopes: operatorScopes } = operatorLayers();
    const global = g.value;
    const workspace = w.value;
    const enabledRefs = enabledPluginRefs(operatorScopes);
    const extensionSurface = opts.extensionProfile?.workspaceTrustSurface();
    const trust = workspaceVerdict(workspace, extensionSurface);
    const enabledPlugins = opts.extensionProfile?.resolvePlugins(enabledRefs, trust) ?? enabledRefs;
    const pluginScopes =
      opts.plugins !== undefined ? opts.plugins.settingsScopes(enabledPlugins) : [];
    const mergeScopes = [...pluginScopes, ...operatorScopes];
    const merged = mergeSettings(mergeScopes, kernelCapabilityRegistry) as unknown as SettingsData;
    const scopes: Partial<Record<Scope, SettingsData>> = {
      ...(global !== undefined ? { global } : {}),
      ...(workspace !== undefined ? { workspace } : {}),
    };
    const errorOf: Partial<Record<Scope, string>> = {
      ...(g.error !== undefined ? { global: g.error } : {}),
      ...(w.error !== undefined ? { workspace: w.error } : {}),
    };
    const sources: SettingsSource[] = SCOPES.map((scope) => {
      const p = settingsPath(scope);
      const document = scope === "global" ? g.document : w.document;
      return {
        scope,
        path: p ?? "",
        exists: (scope === "global" ? g.exists : w.exists) ?? document !== null,
        revision: document?.revision ?? null,
        ...(errorOf[scope] !== undefined ? { error: errorOf[scope] } : {}),
      };
    });
    const withheld = [
      ...(gated?.withheld ?? []),
      ...(extensionSurface !== undefined &&
      (trust.state === "unapproved" || trust.state === "changed")
        ? ["extension_profile"]
        : []),
    ];
    return {
      merged,
      scopes,
      sources,
      ...(withheld.length > 0 ? { withheld_workspace_fields: withheld } : {}),
      workspace_trust: trust,
      active_plugins: enabledPlugins,
      mcpServerOrigins: mcpServerOrigins(mergeScopes),
    };
  };

  /**
   * Parse an agent markdown file (lenient frontmatter) into an
   * {@link AgentRecord}, recording *why* if the frontmatter is malformed.
   *
   * @remarks The lenient parse is what the runtime gets, deliberately: one
   * unparsable profile must not take a workspace down. The strict re-parse
   * exists only to fill {@link AgentRecord.malformed}, because the lenient
   * fallback is indistinguishable from a profile that genuinely declares
   * nothing — `{}` satisfies every optional field of the agent schema, so
   * without this the file reads as a valid agent with no grants, and both the
   * agent list and Doctor report it healthy.
   */
  const parseAgentFile = (scope: Scope, name: string, raw: string): AgentRecord => {
    const { data, body } = splitAgentFrontmatter(raw, "lenient");
    const fm = (data ?? {}) as Record<string, unknown>;
    let malformed: string | undefined;
    try {
      splitAgentFrontmatter(raw, "strict");
    } catch (err) {
      malformed = err instanceof Error ? err.message : String(err);
    }
    return {
      name,
      scope,
      frontmatter: fm,
      body,
      ...(typeof fm.model === "string" ? { model: fm.model } : {}),
      ...(typeof fm.description === "string" ? { description: fm.description } : {}),
      ...(malformed === undefined ? {} : { malformed }),
    };
  };

  /**
   * Whether this workspace's `agents/` directory may contribute at all.
   *
   * @remarks The same verdict that gates the executable settings fields, for
   *   the reason recorded on {@link ConfigStore.listAgents}: an agent's markdown
   *   body becomes a system prompt section verbatim.
   */
  const agentFilesTrusted = (): boolean => workspaceTrusted(readScopeSettings("workspace").value);

  /** Read and parse one agent file, or `null` when that scope holds none by that name. */
  const readAgentFile = (scope: Scope, name: string): AgentRecord | null => {
    const path = agentPath(scope, name);
    if (path === undefined || !existsSync(path)) return null;
    return parseAgentFile(
      scope,
      name,
      readBoundedText(path, MAX_AGENT_DOCUMENT_BYTES, "agent document"),
    );
  };

  /**
   * Assert a scope-derived path exists before a write.
   *
   * @throws an `Error` when `p` is `undefined`, i.e. the scope is not configured
   *   (e.g. writing `workspace` with no workspace root).
   */
  const requireScope = (scope: Scope, p: string | undefined): string => {
    if (p === undefined) throw new Error(`config store has no '${scope}' scope configured`);
    return p;
  };

  /**
   * Decode one already-read settings document without touching the filesystem again.
   *
   * @remarks This deliberately preserves {@link readScopeSettings}'s mutation
   * semantics: an absent, unparsable, or schema-invalid document contributes an
   * empty object. The caller still validates the replacement before it can be
   * persisted. Keeping this projection over the exact bytes whose revision was
   * checked is load-bearing; a second read would reintroduce a TOCTOU window
   * inside the settings lease.
   */
  const settingsFromDocument = (
    document: ReturnType<typeof readSettingsDocument>,
    scope: Scope,
    path: string,
  ): SettingsData => {
    if (document === null) return {};
    let json: unknown;
    try {
      json = JSON.parse(document.raw);
    } catch {
      reportDiscarded(logger, scope, path, "json");
      return {};
    }
    const parsed = kernelSettingsSchema.safeParse(json);
    if (parsed.success) return parsed.data;
    reportDiscarded(logger, scope, path, "schema");
    return {};
  };

  /**
   * Re-read one scope under its local process lease, hand the document to
   * `produce`, and write what comes back atomically.
   *
   * @param scope - the settings scope to rewrite.
   * @param expectedRevision - the revision the caller read at; a mismatch is a
   *   {@link SettingsRevisionConflictError} and nothing is written.
   * @param produce - builds the next document contents. Throwing releases the
   *   lease and writes nothing, which is how validation failure stays a no-op.
   * @returns the snapshot taken *after* {@link withOperatorWrite} returns.
   * @remarks The read happens *inside* the lease, not before it: re-reading is
   *   the whole point, since the caller's own view may predate another
   *   process's write by minutes. `compareAndSwapSettingsDocument` and
   *   `mutateSettings` shared this entire skeleton as two copies, differing only
   *   in what they hand the callback and in whether a missing document is itself
   *   a conflict — which is now the callback's business.
   */
  const rewriteUnderLease = (
    scope: Scope,
    expectedRevision: string | null,
    produce: (document: ReturnType<typeof readSettingsDocument>, path: string) => unknown,
  ): SettingsSnapshot => {
    const path = requireScope(scope, settingsPath(scope));
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const lease = acquireSettingsLock(`${path}.lock`);
    try {
      const document = readSettingsDocument(scope);
      const actualRevision = document?.revision ?? null;
      if (actualRevision !== expectedRevision) {
        throw new SettingsRevisionConflictError(expectedRevision, actualRevision);
      }
      const next = produce(document, path);
      withOperatorWrite(scope, () => {
        writeAtomic(scope, path, `${JSON.stringify(next, null, 2)}\n`);
      });
    } finally {
      lease.release();
    }
    return snapshot();
  };

  return {
    readSettings: () => snapshot(),
    withOperatorWrite,
    readSettingsDocument,
    /**
     * Re-read and repair exact source bytes under the same local process lease
     * as ordinary mutations. A stale preview never reaches `repair` or the writer.
     */
    compareAndSwapSettingsDocument: (scope, expectedRevision, repair) =>
      rewriteUnderLease(scope, expectedRevision, (document) => {
        if (document === null) throw new SettingsRevisionConflictError(expectedRevision, null);
        return repair(document.raw);
      }),
    /**
     * Approve or revoke this workspace's current executable surface.
     *
     * @remarks Approving records the fingerprint computed *now*, so the approval
     * covers exactly what the operator was shown and nothing later.
     */
    setWorkspaceTrust: (approve: boolean) => {
      opts.extensionProfile?.assertWorkspaceTrustTransitionAllowed?.();
      approveCurrentSurface(approve);
      return snapshot();
    },
    workspaceTrustError: () => readWorkspaceTrustFile(globalDir).error ?? null,
    /**
     * Pretty-print the scope's settings as JSON, write it atomically, and
     * re-snapshot.
     *
     * @remarks The snapshot is taken *after* {@link withOperatorWrite} returns,
     *   never inside it: the approval it carries over is recorded after the
     *   write, so a snapshot computed within would report the pre-approval
     *   verdict and hand the caller a `withheld_workspace_fields` warning for
     *   exactly the fields its own write had just re-approved.
     */
    writeSettings: (scope, data) => {
      withOperatorWrite(scope, () => {
        writeAtomic(
          scope,
          requireScope(scope, settingsPath(scope)),
          `${JSON.stringify(data, null, 2)}\n`,
        );
      });
      return snapshot();
    },
    /**
     * Read, transform and persist one scope's settings while holding the local
     * process lease beside it, so a same-host concurrent process cannot lose the update.
     *
     * @remarks The read happens *inside* the lease, not before it: re-reading is
     *   the whole point, since the caller's own view of the scope may predate
     *   another process's write by minutes. `mutate` throwing releases the lease
     *   and writes nothing, which is how validation failure stays a no-op.
     */
    mutateSettings: (scope, expectedRevision, mutate) =>
      rewriteUnderLease(scope, expectedRevision, (document, path) =>
        mutate(settingsFromDocument(document, scope, path)),
      ),
    /**
     * All file agents across scopes, plus plugin-shipped agents for the enabled
     * plugins.
     *
     * @remarks Workspace agents are gated on the same verdict as the executable
     *   settings fields, because an agent's markdown body becomes a system
     *   prompt section verbatim. This is a separate path from the settings
     *   merge; gating only there would leave the prompt wide open to any
     *   repository that shipped an `agents/` directory.
     */
    listAgents: () => {
      const files: AgentRecord[] = [];
      for (const scope of SCOPES) {
        if (scope === "workspace" && !agentFilesTrusted()) continue;
        const dir = agentsDir(scope);
        if (dir === undefined || !existsSync(dir)) continue;
        const page = boundedAgentNames(dir, scope, logger);
        let totalBytes = 0;
        for (const file of page.names) {
          const name = file.slice(0, -3);
          try {
            const raw = readBoundedText(
              join(dir, file),
              MAX_AGENT_DOCUMENT_BYTES,
              "agent document",
            );
            totalBytes += Buffer.byteLength(raw, "utf8");
            if (totalBytes > MAX_AGENT_DOCUMENTS_TOTAL_BYTES) break;
            files.push(parseAgentFile(scope, name, raw));
          } catch {
            continue;
          }
        }
      }
      const byScope = (scope: Scope, name: string): AgentRecord | null =>
        files.find((f) => f.scope === scope && f.name === name) ?? null;
      const out: AgentRecord[] = BUILTIN_AGENT_NAMES.map((name) =>
        resolveEffectiveAgent(name, {
          workspace: byScope("workspace", name),
          global: byScope("global", name),
        })!,
      );
      out.push(...files.filter((f) => !isBuiltinAgent(f.name)));
      if (opts.plugins !== undefined) out.push(...opts.plugins.agents(operatorEnabled()));
      return out;
    },
    /**
     * Read an agent file; when absent and the name is namespaced (`<plugin>:<agent>`),
     * fall back to the plugin contribution. Returns `null` when neither resolves.
     */
    readAgent: (scope, name) => {
      if (scope === "builtin") {
        const builtin = readBuiltinAgent(name);
        return builtin === undefined ? null : builtinAgentRecord(builtin);
      }
      const file = readAgentFile(scope, name);
      if (file !== null) return file;
      if (opts.plugins !== undefined && name.includes(":")) {
        return opts.plugins.readAgent(operatorEnabled(), name);
      }
      return null;
    },
    /**
     * The agent a run enters for `name`: the shipped default, a config file, or
     * the two merged.
     *
     * @remarks An untrusted workspace contributes no layer at all, exactly as it
     *   contributes no entry to {@link listAgents} — otherwise a cloned
     *   repository could rewrite a shipped agent's system prompt just by
     *   shipping `.clarvis/agents/marshall.md`, which is the same authority the
     *   trust gate exists to withhold.
     */
    readEffectiveAgent: (name) => {
      if (name.includes(":")) {
        return opts.plugins === undefined ? null : opts.plugins.readAgent(operatorEnabled(), name);
      }
      return resolveEffectiveAgent(name, {
        workspace: agentFilesTrusted() ? readAgentFile("workspace", name) : null,
        global: readAgentFile("global", name),
      });
    },
    /** Serialize frontmatter to a YAML `---` block above the body, write atomically, and re-parse. */
    writeAgent: (scope, name, input: AgentInput) =>
      withOperatorWrite(scope, () => {
        const fm = stringifyYaml(input.frontmatter).trimEnd();
        const content = `---\n${fm}\n---\n\n${input.body}\n`;
        if (Buffer.byteLength(content, "utf8") > MAX_AGENT_DOCUMENT_BYTES)
          throw new ConfigResourceLimitError(
            requireScope(scope, agentPath(scope, name)),
            "agent document",
            MAX_AGENT_DOCUMENT_BYTES,
          );
        writeAtomic(scope, requireScope(scope, agentPath(scope, name)), content);
        return parseAgentFile(scope, name, content);
      }),
    /** Remove the agent file when it exists; a silent no-op otherwise. */
    deleteAgent: (scope, name) =>
      withOperatorWrite(scope, () => {
        const p = agentPath(scope, name);
        if (p !== undefined && existsSync(p)) rmSync(p, { force: true });
      }),
    /** Return the first of `CLARVIS.md` then `AGENTS.md` under the scope's context base, or `null`. */
    readContext: (scope): ContextRecord | null => {
      const candidates = contextCandidates(scope);
      if (candidates === undefined) return null;
      for (const p of candidates) {
        if (existsSync(p))
          return {
            scope,
            path: p,
            content: readBoundedText(p, MAX_CONTEXT_DOCUMENT_BYTES, "context document"),
          };
      }
      return null;
    },
  };
}
