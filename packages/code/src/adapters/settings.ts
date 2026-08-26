import { createSignal, type Accessor } from "solid-js";
import type { z } from "zod";
import {
  isWellFormedHttpUrl,
  kernelSettingsSchema,
  mergeProviders,
  mergeSettings,
  parseModelRef,
  PLANS_DEFAULTS,
  type providerConfigSchema,
  type SettingsFile,
} from "@clarvis/kernel/config";
import type {
  ConfigService,
  SandboxInspection,
  SettingsData,
  SettingsRepairPlan,
} from "@clarvis/protocol";
import { glyph } from "../core/marks.ts";
import { diagnosticCount, diagnosticEvent } from "../core/diagnostic-events.ts";
import { keyOrigin, type KeysAdapter, type KeySource } from "./provider-secrets.ts";
import { parseMcpServers, type McpServerDecl } from "./mcp-capabilities.ts";
import { zodIssueSummary } from "./zod-summary.ts";

/** A settings file's scope: global (`~/.clarvis`) or workspace (`.clarvis`). */
export type Scope = "global" | "workspace";

/**
 * Note that a fully-qualified model reference did not parse.
 *
 * @param site - the resolution that fell back, so one malformed
 *   `default_model` can be told from one malformed agent model.
 * @param error - the parse failure.
 * @remarks Sampled rather than written every time: all three call sites sit
 *   under Solid memos that recompute on any settings change, and a malformed
 *   reference is a steady state rather than an event.
 *
 *   **All three are currently unreachable**, and that is the interesting part.
 *   `parseModelRef` is total — a reference with no `/` resolves to a provider
 *   of that whole name — so the three `catch` blocks around it have no live
 *   caller and the generic `default_model does not resolve` issue a user sees
 *   comes from the ordinary path, not from a swallowed parse error. This stays
 *   as a guard rather than being deleted, because the fallbacks would otherwise
 *   go back to being silent the day the parser grows a throwing branch;
 *   `settings.test.ts` pins the totality so that day is noticed.
 */
function issueFields(error: z.ZodError): string {
  const names = new Set<string>();
  for (const issue of error.issues) names.add(issue.path.join(".") || "(root)");
  return [...names].slice(0, 12).join(",");
}

/**
 * Record a refused settings write, naming the scope and the offending fields.
 *
 * @param scope - the file the write was aimed at.
 * @param issueCount - how many validation issues the document carries.
 * @param fields - the issue paths, joined per `specs/cross-cutting/observability.md` §3.1;
 *   names only, never a value.
 * @param reason - `unparsable` when the file on disk cannot be read at all,
 *   `invalid` when the merged document fails the kernel schema.
 * @remarks This package deleted a whole `workflows` block on a repair path
 *   once, because it validated a real `settings.json` against a schema that did
 *   not know a registered capability's block. A refusal to write therefore
 *   deserves a durable record rather than only a toast the user dismisses.
 */
function rejectSave(scope: Scope, issueCount: number, fields: string, reason: string): void {
  diagnosticEvent(
    "settings.save.rejected",
    { scope, issue_count: issueCount, fields, reason },
    "error",
  );
}

function noteUnparsedModelRef(site: string, error: unknown): void {
  diagnosticCount(
    "settings.model_ref.unparsed",
    { site, error },
    `settings.model_ref.unparsed.${site}`,
  );
}

export { mergeProviders, mergeSettings };
export type { SettingsFile } from "@clarvis/kernel/config";

/** The planning settings shape consumed by Code configuration surfaces. */
export type PlansSettingsBlock = NonNullable<SettingsFile["plans"]>;

/** Return an independent copy of the effective planning defaults owned by the local host. */
export function defaultPlansSettings(): PlansSettingsBlock {
  return { ...PLANS_DEFAULTS };
}

/** A configured model provider, as validated by the kernel's provider schema. */
export type ProviderConfig = z.infer<typeof providerConfigSchema>;
/** The kind of provider a {@link ProviderConfig} configures. */
export type ProviderKind = ProviderConfig["kind"];

/** One field-level validation failure from {@link SettingsAdapter.validateProviders}. */
export interface FieldIssue {
  field: string;
  message: string;
  provider?: string;
}

type ProviderOrigin = "global" | "workspace" | "shadow";

/** Whether an env var backing a provider's API key is set directly, via a keyfile, or neither. */
export type EnvKeyStatus = "set" | "keyfile" | "unset";

interface EffectiveProvider {
  provider: ProviderConfig;
  origin: ProviderOrigin;
}

/**
 * A plan for repairing a corrupt scope's `settings.json`, produced by
 * {@link SettingsAdapter.planRepair}: `strip` drops the offending keys from
 * otherwise-parsable JSON, `reset` replaces an unparsable file with `{}`.
 */
export type SettingsRepair =
  | (Extract<SettingsRepairPlan, { action: "strip" }> & { path: string })
  | (Extract<SettingsRepairPlan, { action: "reset" }> & { path: string });

/** The four trust states a workspace can be in. */
export type WorkspaceTrustState = "inert" | "trusted" | "unapproved" | "changed";

/** The UI's read/write/validate interface over the kernel's global and workspace settings scopes. */
export interface SettingsAdapter {
  version: Accessor<number>;
  read(scope: Scope): SettingsFile | undefined;
  corrupt(scope: Scope): string | null;
  /**
   * How a corrupt scope can be made valid again: `strip` drops the offending
   * keys from parsable JSON, `reset` replaces an unparsable file with `{}`.
   * Null when the scope is not corrupt. The plan is destructive — callers must
   * confirm with the user before {@link SettingsAdapter.applyRepair}.
   */
  planRepair(scope: Scope): SettingsRepair | null | Promise<SettingsRepair | null>;
  applyRepair(repair: SettingsRepair): Promise<void>;
  effective(): SettingsFile;
  /**
   * Workspace-scope fields the kernel withheld from the merge because a
   * repository may not contribute them on its own authority. Empty for almost
   * every repository; {@link SettingsAdapter.read | read("workspace")} still
   * shows them, since the file on disk is unchanged.
   */
  withheldWorkspaceFields(): readonly string[];
  /**
   * This workspace's trust verdict: `inert` when it declares nothing
   * executable, otherwise `trusted` / `unapproved` / `changed`.
   */
  workspaceTrust(): WorkspaceTrustState;
  /** Approve or revoke this workspace's executable surface, then re-read. */
  setWorkspaceTrust(approve: boolean): Promise<void>;
  /**
   * Which scope supplies `key` in the effective settings, or `undefined` when no
   * scope defines it. A withheld workspace field does not count as workspace —
   * it never reached the merge.
   */
  origin(key: keyof SettingsFile): Scope | undefined;
  effectiveProviders(): EffectiveProvider[];
  /**
   * Every capability grant the kernel will accept on an agent profile, or
   * `undefined` when it did not report one.
   *
   * @remarks Only the kernel can answer this — an optional feature package
   *   contributes its own grant — so a caller given `undefined` must skip the
   *   grant check rather than fall back to a static list.
   */
  knownGrants(): readonly string[] | undefined;
  sources(): { global: string; workspace?: string };
  write(scope: Scope, patch: Partial<SettingsFile>): Promise<void>;
  validateProviders(
    s: SettingsFile,
    resolveAgainst?: ProviderConfig[],
  ): { ok: true } | { ok: false; issues: FieldIssue[] };
  refs(providerName: string): { agents: string[]; defaultModel: boolean };
  modelRefs(fullModelId: string): { agents: string[]; defaultModel: boolean };
  envStatus(varName: string): EnvKeyStatus;
  declaredMcpServers(): McpServerDecl[];
  /** Re-fetch the cached snapshot from the kernel (after an external change). */
  reload(): Promise<void>;
  inspectSandbox(options?: { refresh?: boolean }): Promise<SandboxInspection>;
}

/**
 * Patch one planning-policy field without copying unrelated global defaults
 * into a new workspace override or resetting fields the operator already set.
 */
export async function patchPlansSettings(
  settings: SettingsAdapter,
  scope: Scope,
  patch: Partial<PlansSettingsBlock>,
): Promise<void> {
  const current = settings.read(scope)?.plans;
  const effective = settings.effective().plans;
  const provider = current?.provider ?? effective?.provider;
  await settings.write(scope, {
    plans: {
      mode: patch.mode ?? current?.mode ?? effective?.mode ?? PLANS_DEFAULTS.mode,
      retention:
        patch.retention ?? current?.retention ?? effective?.retention ?? PLANS_DEFAULTS.retention,
      pending_task_nudges:
        patch.pending_task_nudges ??
        current?.pending_task_nudges ??
        effective?.pending_task_nudges ??
        PLANS_DEFAULTS.pending_task_nudges,
      ...(patch.provider !== undefined
        ? { provider: patch.provider }
        : provider !== undefined
          ? { provider }
          : {}),
    },
  });
}

/**
 * Resolve a model's context window from the configured providers, falling back
 * when the model id can't be parsed or isn't found.
 *
 * @param providers - configured providers to look the model up in.
 * @param fullModelId - a fully-qualified `provider/model` reference.
 * @param fallback - the value to return when resolution fails.
 */
export function resolveContextWindow(
  providers: ProviderConfig[] | undefined,
  fullModelId: string | undefined,
  fallback: number,
): number {
  if (!fullModelId) return fallback;
  let modelId: string;
  let providerName: string;
  try {
    const ref = parseModelRef(fullModelId);
    providerName = ref.provider;
    modelId = ref.modelId;
  } catch (error) {
    noteUnparsedModelRef("context_window", error);
    return fallback;
  }
  const win = providers?.find((p) => p.name === providerName)?.models?.[modelId]
    ?.context_window_tokens;
  return typeof win === "number" && win > 0 ? win : fallback;
}

/**
 * Build the {@link SettingsAdapter} over a kernel {@link ConfigService},
 * caching the merged settings view in a signal that bumps on every successful
 * write, reload, or repair.
 *
 * @param config - the kernel's config service.
 * @param opts - optional key-status lookups, for {@link SettingsAdapter.envStatus}.
 */
export async function createSettingsAdapter(
  config: ConfigService,
  opts?: {
    keys?: KeysAdapter;
    keySource?: (varName: string) => KeySource;
    /** An already-fetched agent list, so boot need not repeat the round trip. */
    agents?: Awaited<ReturnType<ConfigService["listAgents"]>>;
  },
): Promise<SettingsAdapter> {
  let view = await config.getSettings();
  let agentList = opts?.agents ?? (await config.listAgents());
  let publicationTail: Promise<void> = Promise.resolve();
  const [version, setVersion] = createSignal(0);

  /**
   * Publish adapter snapshots in invocation order.
   *
   * @remarks Settings writes, reloads, trust changes, and repairs all return a
   * fresh authoritative view. Serializing only writes still lets an older slow
   * reload overwrite a newer mutation after it resolves. Keeping every state-
   * publishing operation on one queue makes the cached view and agent list a
   * single monotonic projection. A failed operation remains the caller's error
   * while the queue continues with the next request.
   */
  function publishInOrder<T>(operation: () => Promise<T>): Promise<T> {
    const result = publicationTail.then(operation);
    publicationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  const asFile = (s: SettingsData | undefined): SettingsFile | undefined =>
    s as SettingsFile | undefined;

  function read(scope: Scope): SettingsFile | undefined {
    return asFile(view.scopes[scope]);
  }

  function sourceRevision(scope: Scope): string | null {
    return view.sources.find((source) => source.scope === scope)?.revision ?? null;
  }

  function corrupt(scope: Scope): string | null {
    return view.sources.find((s) => s.scope === scope)?.error ?? null;
  }

  function effective(): SettingsFile {
    return view.merged as SettingsFile;
  }

  function withheldWorkspaceFields(): readonly string[] {
    return view.withheld_workspace_fields ?? [];
  }

  function workspaceTrust(): WorkspaceTrustState {
    return view.workspace_trust?.state ?? "inert";
  }

  /**
   * Approve or revoke this workspace, then re-read both settings and agents.
   *
   * @remarks The agent list is re-read because agents are gated by the same
   *   verdict — approving a workspace is exactly the moment its agents appear,
   *   and refreshing only the settings view would leave the fleet stale.
   */
  function setWorkspaceTrust(approve: boolean): Promise<void> {
    return publishInOrder(async () => {
      const nextView = approve ? await config.approveWorkspace() : await config.revokeWorkspace();
      const nextAgentList = await config.listAgents();
      view = nextView;
      agentList = nextAgentList;
      setVersion((v) => v + 1);
    });
  }

  function origin(key: keyof SettingsFile): Scope | undefined {
    if (read("workspace")?.[key] !== undefined && !withheldWorkspaceFields().includes(key)) {
      return "workspace";
    }
    if (read("global")?.[key] !== undefined) return "global";
    return undefined;
  }

  function effectiveProviders(): EffectiveProvider[] {
    const g = new Map((read("global")?.providers ?? []).map((p) => [p.name, p]));
    const w = new Map((read("workspace")?.providers ?? []).map((p) => [p.name, p]));
    const out: EffectiveProvider[] = [];
    for (const [name, p] of g) if (!w.has(name)) out.push({ provider: p, origin: "global" });
    for (const [name, p] of w)
      out.push({ provider: p, origin: g.has(name) ? "shadow" : "workspace" });
    return out;
  }

  function knownGrants(): readonly string[] | undefined {
    return view.known_grants;
  }

  function sources(): { global: string; workspace?: string } {
    const pathOf = (scope: Scope): string | undefined =>
      view.sources.find((s) => s.scope === scope)?.path || undefined;
    return { global: pathOf("global") ?? "", workspace: pathOf("workspace") };
  }

  /**
   * Queue one compare-and-swap settings publication.
   *
   * @remarks The source revision is captured immediately before the queued
   * operation's first await. Adapter writes therefore serialize while an
   * external writer still produces an explicit conflict instead of losing its
   * update.
   */
  /**
   * Re-read settings after the kernel refused a write, so the panel stops
   * showing a value that was never persisted.
   *
   * @remarks A concurrent-modification conflict is the case that matters: the
   *   snapshot this adapter holds is, by definition, the stale one the conflict
   *   was reported against. Leaving it in place made Run controls and Memory
   *   settings keep reporting the refused value as `Effective` /
   *   `Source: workspace` indefinitely, with no route to refresh. Failing to
   *   re-read is not allowed to mask the original failure, so the refusal is
   *   still thrown to the caller.
   */
  async function resyncAfterRefusedWrite(
    scope: Scope,
    keys: string,
    cause: unknown,
  ): Promise<void> {
    diagnosticEvent("settings.save.refused", { scope, keys, error: cause }, "warn");
    try {
      view = await config.getSettings();
      agentList = await config.listAgents();
      setVersion((v) => v + 1);
    } catch (error) {
      diagnosticEvent("settings.resync.failed", { scope, error }, "error");
    }
  }

  function write(scope: Scope, patch: Partial<SettingsFile>): Promise<void> {
    const stagedPatch = structuredClone(patch);
    const keys = Object.keys(stagedPatch).sort().join(",");
    return publishInOrder(async () => {
      const parseError = corrupt(scope);
      if (parseError) {
        rejectSave(scope, 1, "", "unparsable");
        throw new Error(
          `${scope} settings.json is invalid (${parseError}) ${glyph("emDash")} fix it by hand before saving`,
        );
      }
      const current = read(scope) ?? {};
      const next: SettingsFile = { ...current, ...stagedPatch };
      const validated = kernelSettingsSchema.safeParse(next);
      if (!validated.success) {
        rejectSave(scope, validated.error.issues.length, issueFields(validated.error), "invalid");
        throw new Error(`refusing to save invalid settings: ${zodIssueSummary(validated.error)}`);
      }

      const expectedRevision = sourceRevision(scope);
      try {
        view = await config.updateSettings(scope, stagedPatch, expectedRevision);
      } catch (error) {
        await resyncAfterRefusedWrite(scope, keys, error);
        throw error;
      }
      diagnosticEvent("settings.save.applied", { scope, keys }, "info");
      setVersion((v) => v + 1);
    });
  }

  function reload(): Promise<void> {
    return publishInOrder(async () => {
      const nextView = await config.getSettings();
      const nextAgentList = await config.listAgents();
      view = nextView;
      agentList = nextAgentList;
      setVersion((v) => v + 1);
    });
  }

  async function planRepair(scope: Scope): Promise<SettingsRepair | null> {
    const plan = await config.previewSettingsRepair(scope);
    if (plan === null) return null;
    const path = view.sources.find((s) => s.scope === scope)?.path ?? "";
    return { ...plan, path };
  }

  function applyRepair(repair: SettingsRepair): Promise<void> {
    return publishInOrder(async () => {
      view = await config.repairSettings(repair.scope, repair.revision);
      setVersion((v) => v + 1);
    });
  }

  function validateProviders(
    s: SettingsFile,
    resolveAgainst?: ProviderConfig[],
  ): { ok: true } | { ok: false; issues: FieldIssue[] } {
    const issues: FieldIssue[] = [];
    const providers = s.providers ?? [];
    if (providers.length === 0)
      issues.push({ field: "providers", message: "at least one provider is required to run" });
    const seenNames = new Set<string>();
    for (const p of providers) {
      if (!p.name)
        issues.push({ field: "name", provider: p.name, message: "provider name is required" });
      else if (!/^[a-z0-9_-]+$/.test(p.name))
        issues.push({ field: "name", provider: p.name, message: "name must match ^[a-z0-9_-]+$" });
      else if (seenNames.has(p.name))
        issues.push({
          field: "name",
          provider: p.name,
          message: `duplicate provider name '${p.name}': names must be unique`,
        });
      else seenNames.add(p.name);
      if (p.kind === "openai-compatible" && !isWellFormedHttpUrl(p.base_url ?? ""))
        issues.push({
          field: "base_url",
          provider: p.name,
          message: "openai-compatible needs an http(s) base_url",
        });
      if (p.api_key_env && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(p.api_key_env))
        issues.push({
          field: "api_key_env",
          provider: p.name,
          message: "must be a valid env var name",
        });
      for (const [id, m] of Object.entries(p.models ?? {})) {
        if (!Number.isInteger(m.context_window_tokens) || m.context_window_tokens <= 0)
          issues.push({
            field: "context_window_tokens",
            provider: p.name,
            message: `model ${id}: window must be a positive integer`,
          });
      }
    }
    if (s.default_model) {
      const knownSet = resolveAgainst ?? providers;
      let known: boolean;
      try {
        // Resolving means the *model* exists, not merely the provider that
        // would host it. Checking the provider name alone reported a default
        // naming a model no provider declares as resolving cleanly, so the
        // first run was the thing that discovered it.
        const ref = parseModelRef(s.default_model);
        const provider = knownSet.find((p) => p.name === ref.provider);
        const models = provider?.models;
        known =
          provider !== undefined &&
          (models === undefined ||
            Object.keys(models).length === 0 ||
            Object.hasOwn(models, ref.modelId));
      } catch (error) {
        noteUnparsedModelRef("default_model", error);
        known = false;
      }
      if (!known)
        issues.push({
          field: "default_model",
          message: `default_model does not resolve: ${s.default_model}`,
        });
    }
    return issues.length === 0 ? { ok: true } : { ok: false, issues };
  }

  function agentModelRefs(): { agent: string; model: string }[] {
    const out: { agent: string; model: string }[] = [];
    for (const a of agentList) {
      if (a.model) out.push({ agent: a.name, model: a.model });
    }
    return out;
  }

  function refs(providerName: string): { agents: string[]; defaultModel: boolean } {
    const cites = (model: string): boolean => {
      try {
        return parseModelRef(model).provider === providerName;
      } catch (error) {
        noteUnparsedModelRef("provider_refs", error);
        return false;
      }
    };
    const agents = agentModelRefs()
      .filter((r) => cites(r.model))
      .map((r) => r.agent);
    const dm = effective().default_model;
    return { agents, defaultModel: !!dm && cites(dm) };
  }

  function modelRefs(fullModelId: string): { agents: string[]; defaultModel: boolean } {
    const agents = agentModelRefs()
      .filter((r) => r.model === fullModelId)
      .map((r) => r.agent);
    return { agents, defaultModel: effective().default_model === fullModelId };
  }

  function envStatus(varName: string): EnvKeyStatus {
    const source = opts?.keySource?.(varName) ?? "auto";
    const origin = keyOrigin(source, !!process.env[varName], !!opts?.keys?.has(varName));
    return origin === "env" ? "set" : origin;
  }

  function declaredMcpServers(): McpServerDecl[] {
    return parseMcpServers(effective().mcpServers);
  }

  return {
    version,
    read,
    corrupt,
    planRepair,
    applyRepair,
    effective,
    withheldWorkspaceFields,
    workspaceTrust,
    setWorkspaceTrust,
    origin,
    effectiveProviders,
    sources,
    write,
    knownGrants,
    validateProviders,
    refs,
    modelRefs,
    envStatus,
    declaredMcpServers,
    reload,
    inspectSandbox: (options) => config.inspectSandbox(options),
  };
}
