import { kernelSettingsSchema } from "./capability-registry.ts";
import { agentFrontmatterSchema, renderSharedPromptDocument } from "@clarvis/loop/host";
import type {
  AgentDoc,
  AgentSummary,
  AgentWrite,
  ConfigChange,
  ConfigChangeKind,
  ConfigService,
  ContextDoc,
  SandboxInspection,
  Scope,
  SettingsData,
  SettingsRepairPlan,
  SettingsView,
  SharedPromptLayerView,
  SharedPromptView,
  SharedPromptWrite,
  Unsubscribe,
} from "@clarvis/protocol";
import { kernelError } from "../core/errors.ts";
import { compareAgentDisplayOrder } from "./agent-resolution.ts";
import {
  SettingsRevisionConflictError,
  type AgentRecord,
  type ConfigStore,
  type SharedPromptFile,
} from "./config-store.ts";
import { resolveStoreSharedPrompt, sharedPromptPaths } from "./shared-prompt.ts";

/** Host-supplied collaborators for {@link createConfigService}. */
export interface ConfigServiceOptions {
  /**
   * Sandbox doctor probe backing {@link ConfigService.inspectSandbox}; when
   * omitted, that method rejects with an `unavailable` kernel error.
   */
  inspectSandbox?: (options?: { refresh?: boolean }) => Promise<SandboxInspection>;
  /**
   * Every grant this kernel's composed capability registry will accept, for
   * {@link SettingsView.known_grants}.
   *
   * @remarks Omitted, the field is left absent rather than reported empty — an
   *   unpopulated vocabulary and one that genuinely admits nothing must not look
   *   alike. This is the only place in the process that can answer the question:
   *   the set is the engine's built-ins plus whatever capabilities this kernel
   *   actually composed, and an optional feature package contributes its own.
   */
  knownGrants?: () => readonly string[];
}

/**
 * Allowed agent-name shape: letters, digits, underscores, hyphens and dots,
 * where the first character may not be a dot.
 *
 * @remarks Dots are admitted because the rest of the system already accepts
 * them — a skill names the agent it runs on with a field whose own pattern
 * allows `.` — so a dotted agent listed and ran while every write, rename and
 * scaffold path refused it.
 *
 * `:` stays out. A plugin-contributed agent is addressed as `<plugin>:<agent>`
 * and is owned by the plugin, not by either writable scope; admitting `:` here
 * would let a write claim a plugin-qualified name that no write path can
 * legitimately target.
 *
 * The pattern is also the path guard. An agent name becomes exactly one
 * filename segment, so it must contain no path separator, no drive or stream
 * separator, and must not be able to name a parent directory; the leading-dot
 * exclusion plus {@link PARENT_SEGMENT} cover the traversal forms.
 */
const AGENT_NAME_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/** A parent-directory reference, rejected anywhere inside an agent name. */
const PARENT_SEGMENT = "..";

/**
 * Guard an agent name against {@link AGENT_NAME_RE} before it is used to build a
 * file path.
 *
 * @throws an `invalid_request` kernel error when the name is empty, starts with
 *   a dot, contains `..`, or contains any character outside letters, numbers,
 *   underscores, hyphens and dots.
 */
function requireAgentName(name: string): void {
  if (!AGENT_NAME_RE.test(name) || name.includes(PARENT_SEGMENT)) {
    throw kernelError(
      "invalid_request",
      "agent name must contain only letters, numbers, underscores, hyphens and dots, " +
        "must not start with a dot, and must not contain '..'",
    );
  }
}

/** The scope not passed in — the only other place an agent name could live. */
function otherScope(scope: Scope): Scope {
  return scope === "global" ? "workspace" : "global";
}

/**
 * Guard that `name` does not already exist in the scope opposite `scope` — an
 * agent name may live in only one of `global`/`workspace` at a time.
 *
 * @remarks
 * This check-then-write is not atomic across processes: a concurrent writer
 * targeting the other scope in the same instant could still land both files.
 * Agent writes have no lock/CAS today (unlike `@clarvis/plan`'s
 * `withLock`/CAS in `packages/plan/src/file-repository.ts`); revisit if a
 * remote/multi-writer kernel is introduced.
 *
 * @throws a `conflict` kernel error naming the scope already holding `name`.
 */
function requireNoCrossScopeConflict(store: ConfigStore, scope: Scope, name: string): void {
  const other = otherScope(scope);
  if (store.readAgent(other, name) !== null) {
    throw kernelError(
      "conflict",
      `agent '${name}' already exists in the ${other} scope; an agent name may exist in only one scope`,
      { name, scope, conflictingScope: other },
    );
  }
}

/** Extract the first Zod issue message for a terse `invalid_request` detail. */
function firstIssue(error: { issues: readonly { message: string }[] }): string {
  return error.issues[0]?.message ?? "invalid input";
}

function layerView(
  file: SharedPromptFile | null,
  source: SharedPromptView["source"],
  from: SharedPromptView["from"],
  scope: Scope,
  diagnostics: SharedPromptView["diagnostics"],
): SharedPromptLayerView {
  const rejected = diagnostics.find((d) => d.scope === scope);
  const exists =
    file !== null &&
    (file.raw !== undefined || file.unreadable === true || file.oversized === true);
  if (rejected !== undefined) return { exists: true, status: "rejected", reason: rejected.reason };
  if (source === scope || (source === "disabled" && from === scope)) {
    return { exists: true, status: "active" };
  }
  return { exists, status: "inherited" };
}

function presentSharedPrompt(store: ConfigStore): SharedPromptView {
  const resolved = resolveStoreSharedPrompt(store);
  const global = store.readSharedPrompt("global");
  const workspace = store.readSharedPrompt("workspace");
  const diagnostics = resolved.diagnostics;
  return {
    source: resolved.source,
    ...(resolved.from !== undefined ? { from: resolved.from } : {}),
    ...(resolved.prompt !== undefined ? { prompt: resolved.prompt } : {}),
    diagnostics,
    paths: sharedPromptPaths(store),
    layers: {
      global: layerView(global, resolved.source, resolved.from, "global", diagnostics),
      ...(workspace === null
        ? {}
        : {
            workspace: layerView(
              workspace,
              resolved.source,
              resolved.from,
              "workspace",
              diagnostics,
            ),
          }),
    },
  };
}

type JsonRecord = Record<string, unknown>;

/** Whether a JSON value is an object settings can be repaired field by field. */
function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Resolve a nested JSON value along a Zod issue path. */
function valueAt(root: unknown, path: readonly PropertyKey[]): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (Array.isArray(current)) current = current[Number(segment)];
    else if (isRecord(current)) current = current[String(segment)];
    else return undefined;
  }
  return current;
}

/** Render a Zod issue path for the repair confirmation UI. */
function joinPath(path: readonly PropertyKey[]): string {
  return path.map(String).join(".");
}

/**
 * Remove a rejected JSON leaf, climbing to the nearest existing ancestor when
 * an earlier repair round already changed an array or object on its path.
 */
function removeLeaf(root: JsonRecord, path: readonly PropertyKey[]): string | null {
  for (let candidate = [...path]; candidate.length > 0; candidate = candidate.slice(0, -1)) {
    const parent = valueAt(root, candidate.slice(0, -1));
    const leaf = candidate[candidate.length - 1];
    if (Array.isArray(parent)) {
      const index = Number(leaf);
      if (Number.isInteger(index) && index >= 0 && index < parent.length) {
        parent.splice(index, 1);
        return joinPath(candidate);
      }
    } else if (isRecord(parent) && Object.hasOwn(parent, String(leaf))) {
      delete parent[String(leaf)];
      return joinPath(candidate);
    }
  }
  return null;
}

/**
 * Iteratively remove schema-invalid leaves from otherwise parseable settings.
 *
 * @remarks Each round removes at least one leaf (or one `unrecognized_keys`
 * group) and re-parses, so the loop terminates on its own; the round cap is a
 * non-termination backstop, not a policy about how much repair is acceptable.
 * Exceeding it returns `null` — the file is reported unrepairable and left
 * untouched — which is the same outcome as a leaf that cannot be removed, so
 * being too low costs a repair that would have converged and being too high
 * costs a few more parses of a document already bounded to
 * {@link MAX_SETTINGS_DOCUMENT_BYTES}. It is set well past the number of
 * independent invalid leaves a hand-authored `settings.json` can plausibly
 * carry.
 */
function stripInvalidSettings(json: JsonRecord): { next: SettingsData; dropped: string[] } | null {
  const data = structuredClone(json);
  const dropped: string[] = [];
  const MAX_REPAIR_ROUNDS = 64;
  for (let round = 0; round < MAX_REPAIR_ROUNDS; round++) {
    const parsed = kernelSettingsSchema.safeParse(data);
    if (parsed.success) return { next: parsed.data, dropped };
    const issue = parsed.error.issues[0];
    if (issue === undefined) return null;
    if (issue.code === "unrecognized_keys") {
      const parent = valueAt(data, issue.path);
      if (!isRecord(parent)) return null;
      for (const key of issue.keys) {
        delete parent[key];
        dropped.push(joinPath([...issue.path, key]));
      }
      continue;
    }
    const removed = removeLeaf(data, issue.path);
    if (removed === null) return null;
    dropped.push(removed);
  }
  return null;
}

interface DerivedSettingsRepair {
  plan: SettingsRepairPlan;
  next: SettingsData;
}

/** Derive both the public plan and the validated replacement from exact bytes. */
function deriveSettingsRepair(
  scope: Scope,
  raw: string,
  revision: string,
): DerivedSettingsRepair | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return {
      plan: {
        scope,
        revision,
        action: "reset",
        reason: err instanceof Error ? err.message : "settings JSON cannot be parsed",
      },
      next: {},
    };
  }

  if (!isRecord(json)) {
    return {
      plan: {
        scope,
        revision,
        action: "reset",
        reason: "settings JSON must be an object",
      },
      next: {},
    };
  }

  const stripped = stripInvalidSettings(json);
  if (stripped === null) {
    const parsed = kernelSettingsSchema.safeParse(json);
    return {
      plan: {
        scope,
        revision,
        action: "reset",
        reason: parsed.success ? "settings could not be repaired safely" : firstIssue(parsed.error),
      },
      next: {},
    };
  }
  if (stripped.dropped.length === 0) return null;
  return {
    plan: { scope, revision, action: "strip", dropped: stripped.dropped },
    next: stripped.next,
  };
}

/** Coerce a frontmatter value to a string array, or `undefined` when not an array. */
function strArray(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.map(String) : undefined;
}

/**
 * Project an agent's `budget` frontmatter into the summary's budget shape,
 * keeping only well-typed `on_exceed`/`total_token_limit` fields.
 *
 * @returns the budget, or `undefined` when the frontmatter has no usable budget.
 */
function budgetFrom(fm: Record<string, unknown>): AgentSummary["budget"] {
  const b = fm.budget;
  if (!b || typeof b !== "object") return undefined;
  const rec = b as { on_exceed?: unknown; total_token_limit?: unknown };
  const budget: NonNullable<AgentSummary["budget"]> = {};
  if (typeof rec.on_exceed === "string") budget.on_exceed = rec.on_exceed;
  if (typeof rec.total_token_limit === "number") budget.total_token_limit = rec.total_token_limit;
  return Object.keys(budget).length > 0 ? budget : undefined;
}

/** Project a stored {@link AgentRecord} into the list-projection {@link AgentSummary}. */
function recordToSummary(r: AgentRecord): AgentSummary {
  const grants = strArray(r.frontmatter.grants);
  const canSpawn = strArray(r.frontmatter.can_spawn);
  const budget = budgetFrom(r.frontmatter);
  return {
    name: r.name,
    scope: r.scope,
    ...(r.model !== undefined ? { model: r.model } : {}),
    ...(r.description !== undefined ? { description: r.description } : {}),
    ...(r.plugin !== undefined ? { plugin: r.plugin } : {}),
    ...(grants !== undefined ? { grants } : {}),
    ...(canSpawn !== undefined ? { can_spawn: canSpawn } : {}),
    ...(budget !== undefined ? { budget } : {}),
    ...(r.overlay !== undefined ? { overlay: r.overlay } : {}),
  };
}

/** Project a stored {@link AgentRecord} into the full editable {@link AgentDoc}. */
function recordToDoc(r: AgentRecord, scope: Scope | "builtin"): AgentDoc {
  return {
    name: r.name,
    scope,
    frontmatter: r.frontmatter,
    body: r.body,
    ...(r.malformed === undefined ? {} : { malformed: r.malformed }),
  };
}

/**
 * Build the protocol {@link ConfigService} over a {@link ConfigStore}.
 *
 * The service is the validating, async control-plane surface a client programs
 * against; the store owns raw persistence. Settings and agent frontmatter are
 * validated (Zod) before every write, agent names are path-guarded, and watch
 * subscriptions are filtered to the kinds a listener asked for.
 *
 * @param store - the backing {@link ConfigStore} (file-backed or in-memory).
 * @param options - optional host collaborators; see {@link ConfigServiceOptions}.
 * @returns a {@link ConfigService} whose methods reject with `kernelError`s on
 *   invalid input (`invalid_request`), missing agents (`not_found`), and an
 *   absent sandbox probe (`unavailable`).
 */
export function createConfigService(
  store: ConfigStore,
  options: ConfigServiceOptions = {},
): ConfigService {
  /**
   * Stamp the host's grant vocabulary onto every view this service hands out.
   *
   * @remarks Applied at each exit rather than inside the store, because the
   *   store persists settings and this is a property of the running kernel.
   */
  const withKnownGrants = (view: SettingsView): SettingsView => {
    const grants = options.knownGrants?.();
    return grants === undefined ? view : { ...view, known_grants: grants };
  };
  return {
    /** Return the current merged + per-scope {@link SettingsView}. */
    async getSettings(): Promise<SettingsView> {
      return withKnownGrants(store.readSettings());
    },

    /** Preview a repair bound to the SHA-256 revision of exact source bytes. */
    async previewSettingsRepair(scope: Scope): Promise<SettingsRepairPlan | null> {
      const document = store.readSettingsDocument(scope);
      if (document === null) return null;
      return deriveSettingsRepair(scope, document.raw, document.revision)?.plan ?? null;
    },

    /**
     * Recompute and write a repair under the store's compare-and-swap lock.
     * A changed or disappeared source is reported as a protocol conflict and is
     * never overwritten.
     */
    async repairSettings(scope: Scope, expectedRevision: string): Promise<SettingsView> {
      try {
        return withKnownGrants(
          store.compareAndSwapSettingsDocument(scope, expectedRevision, (raw) => {
            const repair = deriveSettingsRepair(scope, raw, expectedRevision);
            if (repair === null) {
              throw kernelError(
                "conflict",
                `${scope} settings.json is valid again; nothing to repair`,
                { scope, expectedRevision },
              );
            }
            return repair.next;
          }),
        );
      } catch (err) {
        if (err instanceof SettingsRevisionConflictError) {
          throw kernelError("conflict", `${scope} settings.json changed since repair preview`, {
            scope,
            expectedRevision: err.expectedRevision,
            actualRevision: err.actualRevision,
          });
        }
        throw err;
      }
    },

    /**
     * Approve this workspace's executable surface.
     *
     * @remarks A store with no notion of workspace trust (the in-memory one)
     *   simply re-reads: there is nothing to approve, which is the same answer
     *   an inert workspace gets.
     */
    async approveWorkspace(): Promise<SettingsView> {
      return withKnownGrants(store.setWorkspaceTrust?.(true) ?? store.readSettings());
    },

    /** Revoke every approval recorded for this workspace. */
    async revokeWorkspace(): Promise<SettingsView> {
      return withKnownGrants(store.setWorkspaceTrust?.(false) ?? store.readSettings());
    },

    /** The workspace trust store's parse error, or `null` when readable. */
    async workspaceTrustError(): Promise<string | null> {
      return store.workspaceTrustError?.() ?? null;
    },

    /**
     * Merge `patch` onto the named scope's existing settings, validate the result,
     * and persist it.
     *
     * @param scope - the scope to write (`global` or `workspace`).
     * @param patch - a shallow partial merged over the scope's current settings.
     * @param expectedRevision - the exact source revision the caller edited, or
     *   `null` when it observed no file.
     * @returns the refreshed {@link SettingsView} after the write.
     * @throws an `invalid_request` kernel error (carrying the Zod issues) when the
     *   merged settings fail {@link kernelSettingsSchema}; nothing is written in that case.
     * @remarks Routed through {@link ConfigStore.mutateSettings}, so the merge
     *   reads the scope as it sits on disk at write time
     *   rather than as the caller last saw it. Without that, a second process
     *   editing the same file silently drops whichever update landed first —
     *   and because `patch` is merged shallowly, what disappears is a whole
     *   top-level block. The global scope makes this ordinary rather than exotic:
     *   it is one file under the Clarvis home shared by every workspace, so two
     *   `code` instances in unrelated projects are two writers of it.
     */
    async updateSettings(
      scope: Scope,
      patch: Partial<SettingsData>,
      expectedRevision: string | null,
    ): Promise<SettingsView> {
      const merge = (current: SettingsData): SettingsData => {
        const next: SettingsData = { ...current, ...patch };
        const parsed = kernelSettingsSchema.safeParse(next);
        if (!parsed.success) {
          throw kernelError("invalid_request", firstIssue(parsed.error), parsed.error.issues);
        }
        return next;
      };
      try {
        return withKnownGrants(store.mutateSettings(scope, expectedRevision, merge));
      } catch (error) {
        if (error instanceof SettingsRevisionConflictError) {
          throw kernelError("conflict", `${scope} settings.json changed before save`, {
            scope,
            expectedRevision: error.expectedRevision,
            actualRevision: error.actualRevision,
          });
        }
        throw error;
      }
    },

    /**
     * Run the sandbox doctor probe via {@link ConfigServiceOptions.inspectSandbox}.
     *
     * @returns the {@link SandboxInspection} snapshot.
     * @throws (rejects with) an `unavailable` kernel error when no probe was
     *   supplied to {@link createConfigService}.
     */
    inspectSandbox(inspectOptions): Promise<SandboxInspection> {
      if (options.inspectSandbox === undefined) {
        return Promise.reject(kernelError("unavailable", "sandbox inspection is unavailable"));
      }
      return options.inspectSandbox(inspectOptions);
    },

    /**
     * List every visible agent as an {@link AgentSummary}, in presentation order.
     *
     * @remarks Sorting here rather than in each client is what makes the order a
     *   contract instead of a coincidence: see {@link compareAgentDisplayOrder}.
     */
    async listAgents(): Promise<AgentSummary[]> {
      return store.listAgents().map(recordToSummary).sort(compareAgentDisplayOrder);
    },

    /**
     * Load one editable agent document.
     *
     * @param scope - the scope that owns the agent file.
     * @param name - the agent name (path-guarded).
     * @returns the full {@link AgentDoc}.
     * @throws an `invalid_request` error for an ill-formed name, or a `not_found`
     *   error when no such agent exists in `scope`.
     */
    async getAgent(scope: Scope | "builtin", name: string): Promise<AgentDoc> {
      requireAgentName(name);
      const record = store.readAgent(scope, name);
      if (record === null) throw kernelError("not_found", `agent '${name}' not found in ${scope}`);
      return recordToDoc(record, scope);
    },

    /**
     * Create or overwrite an agent document after validating its frontmatter.
     *
     * @param scope - the target scope.
     * @param name - the agent name (path-guarded).
     * @param doc - the frontmatter + body to write.
     * @returns the {@link AgentSummary} of the written agent.
     * @throws an `invalid_request` error for an ill-formed name or frontmatter that
     *   fails {@link agentFrontmatterSchema}; a `conflict` error when `name` already
     *   exists in the other scope (see {@link requireNoCrossScopeConflict}) — this
     *   fires even when overwriting an already-conflicting agent in place, so a
     *   legacy conflict must be resolved (delete/rename one copy) before either
     *   copy can be edited again; nothing is written in either error case.
     */
    async writeAgent(scope: Scope, name: string, doc: AgentWrite): Promise<AgentSummary> {
      requireAgentName(name);
      requireNoCrossScopeConflict(store, scope, name);
      const parsed = agentFrontmatterSchema.safeParse(doc.frontmatter);
      if (!parsed.success) {
        throw kernelError("invalid_request", firstIssue(parsed.error), parsed.error.issues);
      }
      const record = store.writeAgent(scope, name, {
        frontmatter: doc.frontmatter,
        body: doc.body,
      });
      return recordToSummary(record);
    },

    /**
     * Delete an agent document; a no-op when it does not exist.
     *
     * @throws an `invalid_request` error for an ill-formed name.
     */
    async deleteAgent(scope: Scope, name: string): Promise<void> {
      requireAgentName(name);
      store.deleteAgent(scope, name);
    },

    /**
     * Rename an agent within its current scope.
     *
     * Does not move an agent between scopes — write a new agent under the
     * target scope (and delete the old one) for that.
     *
     * @param scope - the scope that owns the agent (unchanged by the rename).
     * @param oldName - the agent's current name.
     * @param newName - the new name.
     * @returns the {@link AgentSummary} of the renamed agent.
     * @throws an `invalid_request` error for an ill-formed name or when
     *   `newName === oldName`; `not_found` when `oldName` doesn't exist in
     *   `scope`; `conflict` when `newName` already exists in `scope` or in the
     *   other scope.
     * @remarks Implemented as write-new-then-delete-old, not a single atomic
     *   filesystem transaction: if the process dies between the two steps,
     *   both names remain on disk under `scope` — a same-scope leftover, not a
     *   new cross-scope conflict, recoverable by deleting the stale one. A
     *   rejected rename never writes anything, so `oldName` is left intact.
     */
    async renameAgent(scope: Scope, oldName: string, newName: string): Promise<AgentSummary> {
      requireAgentName(oldName);
      requireAgentName(newName);
      if (newName === oldName) {
        throw kernelError("invalid_request", "new name must differ from the current name");
      }
      const existing = store.readAgent(scope, oldName);
      if (existing === null) {
        throw kernelError("not_found", `agent '${oldName}' not found in ${scope}`);
      }
      if (store.readAgent(scope, newName) !== null) {
        throw kernelError("conflict", `agent '${newName}' already exists in ${scope}`);
      }
      requireNoCrossScopeConflict(store, scope, newName);
      const record = store.writeAgent(scope, newName, {
        frontmatter: existing.frontmatter,
        body: existing.body,
      });
      store.deleteAgent(scope, oldName);
      return recordToSummary(record);
    },

    /**
     * Load the context preamble for a scope, if present.
     *
     * @returns the {@link ContextDoc} (its `path` defaulting to `""` when the store
     *   records none), or `null` when the scope has no context file.
     */
    async getContext(scope: Scope): Promise<ContextDoc | null> {
      const record = store.readContext(scope);
      return record === null ? null : { scope, path: record.path ?? "", content: record.content };
    },

    async getSharedPrompt(): Promise<SharedPromptView> {
      return presentSharedPrompt(store);
    },

    async writeSharedPrompt(scope: Scope, doc: SharedPromptWrite): Promise<SharedPromptView> {
      if (doc.mode !== "replace" && doc.mode !== "disabled") {
        throw kernelError("invalid_request", 'mode must be "replace" or "disabled"');
      }
      const body = doc.body.trim();
      if (doc.mode === "replace" && body.length === 0) {
        throw kernelError("invalid_request", "replace requires a non-empty body");
      }
      if (doc.mode === "disabled" && body.length > 0) {
        throw kernelError("invalid_request", "disabled requires an empty body");
      }
      store.writeSharedPrompt(scope, renderSharedPromptDocument(doc.mode, body));
      return presentSharedPrompt(store);
    },

    async deleteSharedPrompt(scope: Scope): Promise<void> {
      store.deleteSharedPrompt(scope);
    },

    /**
     * Subscribe to config changes, delivering only the requested {@link kinds}.
     *
     * @param kinds - change kinds to forward; others are dropped.
     * @param listener - invoked with each matching {@link ConfigChange}.
     * @returns an {@link Unsubscribe} handle; a no-op unsubscribe when the backing
     *   store does not support watching.
     */
    subscribe(kinds: ConfigChangeKind[], listener: (change: ConfigChange) => void): Unsubscribe {
      if (store.watch === undefined) return () => {};
      return store.watch((change) => {
        if (kinds.includes(change.kind)) listener(change);
      });
    },
  };
}
