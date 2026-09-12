import type { Accessor } from "solid-js";
import type { SandboxInspection, SubscriptionScheme, SubscriptionState } from "@clarvis/protocol";
import { CLARVIS_DIR, globalPaths } from "@clarvis/paths";
import type { Scope, SettingsAdapter } from "../adapters/settings.ts";
import { resolvedGuardMode } from "../adapters/guard-mode.ts";
import {
  deriveIsolation,
  memoryState,
  modelResolves,
  planRetentionLabel,
  plansState,
} from "../adapters/execution-safety.ts";
import { agentReadiness, type AgentFile, type EnvView } from "../adapters/agent-files.ts";
import type { CodeConfigStore } from "../adapters/code-config.ts";
import { glyph } from "../core/marks.ts";
import { activeDiagnosticSession, diagnosticEvent } from "../core/diagnostic-events.ts";
import { errorText } from "../adapters/errors.ts";

/** Identifier of one readiness gate the doctor evaluates. */
export type GateId =
  | "config"
  | "providers"
  | "credentials"
  | "agents"
  | "default_model"
  | "default_agent"
  | "theme"
  | "memory"
  | "plans"
  | "run_safety"
  | "workspace_trust"
  | "backend"
  | "diagnostics";

type GateSeverity = "hard" | "soft" | "ui" | "comms";
type GateStatus = "pass" | "warn" | "fail";

/** The outcome of one gate's {@link Gate.check} for the current context. */
export interface GateResult {
  status: GateStatus;
  detail: string;
  hint?: string;
  /** Overrides the gate's static fix for this particular failure mode. */
  fix?: FixKind;
}

/** The remedial action a doctor row's fix key offers for a failing/warning gate. */
export type FixKind =
  | {
      kind: "view";
      view: "providers" | "model" | "defaults" | "theme" | "agents" | "memory" | "controls";
    }
  | { kind: "set-default" }
  | { kind: "set-key" }
  | { kind: "reconnect" }
  | { kind: "repair-settings"; scope: Scope };

/** One readiness check the doctor runs against the current configuration. */
export interface Gate {
  id: GateId;
  label: string;
  severity: GateSeverity;
  optional?: boolean;
  fix?: FixKind;
  check(ctx: DoctorCtx): GateResult;
}

/** Reachability state of the kernel backend, as observed by the doctor's `backend` gate. */
export interface BackendProbe {
  status: "checking" | "reachable" | "unreachable";
  profileCount?: number;
}

/** Inputs a {@link Gate.check} reads to decide its {@link GateResult}. */
export interface DoctorCtx {
  settings: SettingsAdapter;
  agents: {
    list: () => AgentFile[];
    /** Names present in both `global` and `workspace` — a legacy cross-scope conflict. */
    conflicts: () => string[];
  };
  code: CodeConfigStore;
  env: EnvView;
  backend: Accessor<BackendProbe>;
  sandboxInspection: Accessor<SandboxInspection | null>;
  subscriptionReadiness?: Accessor<
    Partial<Record<SubscriptionScheme, { state: SubscriptionState; entitled?: boolean }>>
  >;
}

/** The full result of {@link runGates}: every gate, its outcome, and whether startup is blocked. */
export interface DoctorReport {
  gates: Gate[];
  results: Record<GateId, GateResult>;
  blocked: boolean;
}

/**
 * Readiness codes the `agents` gate owns, as opposed to those another gate
 * already reports.
 *
 * @remarks A missing or unresolvable model is the `providers` and
 * `default_model` gates' subject, and reporting it here too turned one
 * incomplete setup into three warnings. What is left is what nothing else
 * looks at: the profile's own shape, and above all a grant no capability
 * declares — the case where every run in the workspace was rejected before its
 * first model call while Doctor reported `Ready`.
 */
const PROFILE_SHAPED_ISSUES: ReadonlySet<string> = new Set([
  "malformed_frontmatter",
  "unknown_grant",
  "unknown_spawn_target",
  "default_spawn_not_in_can_spawn",
  "orchestration_needs_can_spawn",
  "budget_needs_limit",
]);

/** The doctor's fixed set of readiness gates, in the order they are shown. */
export const GATES: Gate[] = [
  {
    id: "config",
    label: "config",
    severity: "hard",
    fix: { kind: "view", view: "providers" },
    check: (ctx) => {
      const g = ctx.settings.read("global");
      const w = ctx.settings.read("workspace");
      const bad = (["global", "workspace"] as Scope[]).find((s) => ctx.settings.corrupt(s));
      if (bad)
        return {
          status: "fail",
          detail: ctx.settings.corrupt(bad)!,
          hint: "repair it (strip unknown keys / reset " + glyph("emDash") + " asks first)",
          fix: { kind: "repair-settings", scope: bad },
        };
      if (!g && !w)
        return {
          status: "fail",
          detail: "no settings.json",
          hint: `create it in ${globalPaths().root} or <ws>/${CLARVIS_DIR}`,
        };
      const src = ctx.settings.sources();
      const where = [g && "global", w && "workspace"].filter(Boolean).join("+");
      const path = w ? (src.workspace ?? src.global) : src.global;
      return { status: "pass", detail: `${path} (${where})` };
    },
  },
  {
    id: "agents",
    label: "agents",
    severity: "hard",
    /**
     * There is no "install the agents" branch here any more: Clarvis ships its
     * agents as data, so a normal host that has never written an agent file
     * still has all five. An actually empty effective fleet is nevertheless a
     * hard failure because it means the shipped data is unavailable. A
     * customization may instead produce a non-blocking conflict, invalid
     * profile, or refused overlay below.
     */
    check: (ctx) => {
      const list = ctx.agents.list();
      if (list.length === 0)
        return { status: "fail", detail: "no agents", hint: "the shipped fleet is unavailable" };
      const conflicts = ctx.agents.conflicts();
      const invalid = list.filter((a) => a.invalid);
      const refused = list.filter((a) => a.overlay?.status === "rejected");
      if (conflicts.length > 0 || invalid.length > 0 || refused.length > 0) {
        const parts = [
          ...(conflicts.length ? [`${conflicts.length} duplicate name(s)`] : []),
          ...(invalid.length ? [`${invalid.length} invalid`] : []),
          ...(refused.length ? [`${refused.length} customization(s) refused`] : []),
        ];
        const hint =
          conflicts.length > 0
            ? `${conflicts.slice(0, 3).join(", ")}${conflicts.length > 3 ? "…" : ""} exist in both global and workspace; rename or delete one copy`
            : refused.length > 0
              ? `${refused[0]!.name} is running as shipped; your ${refused[0]!.overlay!.scope} file was refused (${refused[0]!.overlay!.reason})`
              : `fix the .md frontmatter by hand: ${invalid[0]!.name} (${invalid[0]!.invalid})`;
        return {
          status: "warn",
          detail: `${list.length} agent(s), ${parts.join(", ")}`,
          hint,
          ...(conflicts.length > 0 || refused.length > 0
            ? { fix: { kind: "view", view: "agents" } as const }
            : {}),
        };
      }
      const unrunnable = list
        .map((agent) => ({
          agent,
          blockers: agentReadiness(
            agent,
            list,
            ctx.settings.effective(),
            ctx.env,
            ctx.settings.knownGrants(),
          ).issues.filter((issue) => PROFILE_SHAPED_ISSUES.has(issue.code)),
        }))
        .filter((entry) => entry.blockers.length > 0);
      if (unrunnable.length > 0) {
        const first = unrunnable[0]!;
        return {
          status: "warn",
          detail: `${list.length} agent(s), ${unrunnable.length} not runnable`,
          hint: `${first.agent.name}: ${first.blockers[0]!.message}`,
          fix: { kind: "view", view: "agents" } as const,
        };
      }
      return { status: "pass", detail: `${list.length} agent(s)` };
    },
  },
  {
    id: "providers",
    label: "provider",
    severity: "soft",
    fix: { kind: "view", view: "providers" },
    check: (ctx) => {
      const eff = ctx.settings.effective();
      const providers = eff.providers ?? [];
      if (providers.length === 0)
        return {
          status: "warn",
          detail: "no provider declared",
          hint: "add one " + glyph("emDash") + " the models.dev catalog is available here",
        };
      const v = ctx.settings.validateProviders(eff);
      if (!v.ok) {
        const structural = v.issues.filter((i) => i.field !== "default_model");
        const f = structural[0];
        if (f)
          return { status: "warn", detail: f.provider ? `${f.provider}: ${f.message}` : f.message };
      }
      return {
        status: "pass",
        detail: `${providers.length} ${glyph("separator")} ${providers.map((p) => p.name).join(", ")}`,
      };
    },
  },
  {
    id: "credentials",
    label: "credential",
    severity: "soft",
    fix: { kind: "set-key" },
    check: (ctx) => {
      const providers = ctx.settings.effective().providers ?? [];
      const subscriptions = providers.filter(
        (provider): provider is typeof provider & { kind: SubscriptionScheme } =>
          provider.kind === "openai-codex" || provider.kind === "xai-grok",
      );
      for (const provider of subscriptions) {
        const readiness = ctx.subscriptionReadiness?.()[provider.kind];
        if (readiness === undefined) {
          return {
            status: "pass",
            detail: `${provider.name}: subscription check deferred`,
            hint: "open Providers or recheck Doctor to verify subscription billing",
          };
        }
        if (readiness.state !== "connected") {
          return {
            status: "warn",
            detail: `${provider.name}: ${readiness.state.replaceAll("_", " ")}`,
            hint: "subscription billing needs connection or reauthentication; an API key is separate",
            fix: { kind: "view", view: "providers" },
          };
        }
        if (readiness.entitled !== true) {
          return {
            status: "warn",
            detail: `${provider.name}: ${readiness.entitled === false ? "entitlement denied" : "checking entitlement"}`,
            hint: "open Providers to refresh the entitled subscription model catalog",
            fix: { kind: "view", view: "providers" },
          };
        }
      }
      const needing = providers.filter((p) => p.api_key_env);
      if (needing.length === 0) return { status: "pass", detail: "no credentials required" };
      const missing = needing.filter((p) => ctx.settings.envStatus(p.api_key_env!) === "unset");
      if (missing.length) {
        const first = missing[0]!;
        return {
          status: "warn",
          detail: `${first.api_key_env} not in env`,
          hint: `enter the key (saved beside ${ctx.settings.sources().global || "settings.json"}) or export the env var`,
        };
      }
      const inEnv = needing.filter((p) => ctx.settings.envStatus(p.api_key_env!) === "set").length;
      const inFile = needing.length - inEnv;
      const parts: string[] = [];
      if (inEnv) parts.push(`${inEnv} in env`);
      if (inFile) parts.push(`${inFile} in keys.json`);
      return { status: "pass", detail: parts.join(" " + glyph("separator") + " ") };
    },
  },
  {
    id: "default_model",
    label: "default model",
    severity: "soft",
    fix: { kind: "view", view: "model" },
    check: (ctx) => {
      const eff = ctx.settings.effective();
      const list = ctx.agents.list();
      const defName = ctx.code.agentDefault() ?? list[0]?.name;
      const defAgent = list.find((a) => a.name === defName);
      const model = eff.default_model ?? defAgent?.frontmatter.model ?? ctx.env.defaultModel;
      if (!model)
        return {
          status: "warn",
          detail: "no model",
          hint: "set default_model (or a per-agent model)",
        };
      if (!modelResolves(model, eff))
        return {
          status: "warn",
          detail: `${model} does not resolve`,
          hint: "point at a declared provider",
        };
      const via = eff.default_model
        ? "default_model"
        : defAgent
          ? defAgent.name
          : "CLARVIS_DEFAULT_MODEL";
      return {
        status: "pass",
        detail: `${model} ${glyph("separator")} ${via}  ${glyph("success")}`,
      };
    },
  },
  {
    id: "workspace_trust",
    label: "workspace trust",
    severity: "ui",
    optional: true,
    /**
     * Report whether this repository's executable configuration is approved.
     *
     * @remarks Keyed on the trust verdict, never on `withheldWorkspaceFields()`
     *   alone: that list covers settings fields only, so a workspace whose
     *   executable surface is just `.clarvis/agents/*.md` would report "nothing
     *   withheld" while every one of its agents was in fact being held back —
     *   the fleet silently empty and the gate saying all is well.
     */
    check: (ctx) => {
      const state = ctx.settings.workspaceTrust();
      if (state === "inert" || state === "trusted") {
        return { status: "pass", detail: state === "trusted" ? "approved" : "nothing to approve" };
      }
      const fields = ctx.settings.withheldWorkspaceFields();
      const parts = [...fields, ...(fields.length === 0 ? ["agents"] : [])];
      return {
        status: "warn",
        detail:
          state === "changed"
            ? `this workspace changed since you approved it; withheld: ${parts.join(", ")}`
            : `withheld from this workspace: ${parts.join(", ")}`,
        hint: "review the approval prompt when the workspace opens; /workspace-trust reopens it later",
      };
    },
  },
  {
    id: "run_safety",
    label: "run safety",
    severity: "ui",
    optional: true,
    fix: { kind: "view", view: "controls" },
    check: (ctx) => {
      const eff = ctx.settings.effective();
      const isolation = deriveIsolation(eff);
      const reviewMode = resolvedGuardMode(eff.guard);
      const review = reviewMode === "on" ? "approval" : reviewMode;
      const posture = `${isolation} ${glyph("separator")} review ${review}`;
      if (isolation !== "host") {
        const a = ctx.sandboxInspection()?.backend;
        if (!a) {
          return {
            status: "pass",
            detail: `${posture} ${glyph("emDash")} checking Sandbox host`,
          };
        }
        if ((isolation === "docker" || isolation === "podman") && !a.available) {
          return {
            status: "warn",
            detail: `${posture} ${glyph("emDash")} Sandbox fallback unavailable`,
            hint: `The container still starts lazily; if ${isolation === "docker" ? "Docker" : "Podman"} cannot start, the run fails closed because native Sandbox ${a.reason}.`,
          };
        }
        if (isolation === "docker" || isolation === "podman") {
          return {
            status: "pass",
            detail: `${posture} ${glyph("emDash")} starts on first run; Sandbox fallback ready`,
          };
        }
        if (!a.available) {
          return {
            status: "warn",
            detail: `${posture} ${glyph("emDash")} Sandbox unavailable here`,
            hint: `Native sandbox ${a.reason}; runs will fail. Switch Isolation to Host or install the native sandbox.`,
          };
        }
      }
      if (isolation === "host" && reviewMode === "off") {
        return {
          status: "warn",
          detail: posture,
          hint: "commands run directly, unsandboxed and without approval; open Run controls to change",
        };
      }
      return { status: "pass", detail: posture };
    },
  },
  {
    id: "default_agent",
    label: "default agent",
    severity: "ui",
    optional: true,
    fix: { kind: "set-default" },
    check: (ctx) => {
      const set = ctx.code.agentDefault();
      const list = ctx.agents.list();
      if (!set) {
        const fallback = list[0];
        if (!fallback)
          return { status: "warn", detail: "no agents", hint: "choose an entry agent" };
        const seal = agentReadiness(
          fallback,
          list,
          ctx.settings.effective(),
          ctx.env,
          ctx.settings.knownGrants(),
        );
        if (!seal.runnable)
          return {
            status: "warn",
            detail: `using ${fallback.name}: ${seal.issues[0]?.message ?? "not runnable"}`,
            hint: "choose an entry agent",
          };
        return {
          status: "pass",
          detail: `using ${fallback.name}`,
          hint: "set it as the default",
        };
      }
      const agent = list.find((a) => a.name === set);
      if (!agent)
        return { status: "warn", detail: `${set} no longer exists`, hint: "choose another" };
      const seal = agentReadiness(
        agent,
        list,
        ctx.settings.effective(),
        ctx.env,
        ctx.settings.knownGrants(),
      );
      if (!seal.runnable)
        return { status: "warn", detail: `${set}: ${seal.issues[0]?.message ?? "not runnable"}` };
      return { status: "pass", detail: set };
    },
  },
  {
    id: "theme",
    label: "theme",
    severity: "ui",
    optional: true,
    fix: { kind: "view", view: "theme" },
    check: (ctx) => {
      const t = ctx.code.effectiveTheme();
      const preset = t.preset ? ` ${glyph("separator")} ${t.preset}` : "";
      return { status: "pass", detail: `${t.mode ?? "auto"}${preset}` };
    },
  },
  {
    id: "memory",
    label: "memory",
    severity: "ui",
    optional: true,
    fix: { kind: "view", view: "memory" },
    check: (ctx) => {
      const eff = ctx.settings.effective();
      const m = eff.memory;
      if (m === undefined)
        return {
          status: "warn",
          detail: "not configured",
          hint: "open Memory settings to create it",
        };
      if (m.enabled === false) return { status: "pass", detail: "disabled in settings" };
      if (memoryState(eff) === "inert")
        return {
          status: "warn",
          detail: "no extraction model resolves",
          hint:
            "set memory.model or default_model " +
            glyph("emDash") +
            " the wiki stays readable, and runs queue until one does",
        };
      return { status: "pass", detail: m.model ?? eff.default_model! };
    },
  },
  {
    id: "plans",
    label: "plans",
    severity: "ui",
    optional: true,
    fix: { kind: "view", view: "controls" },
    check: (ctx) => {
      const state = plansState(ctx.settings.effective());
      const policy = `${state.mode === "review" ? "approval required" : "on"} ${glyph("separator")} ${planRetentionLabel(state.retention)}`;
      if (!state.configured)
        return {
          status: "pass",
          detail: `${policy} (defaults)`,
          hint: "use /plan to require review; Run controls sets retention",
        };
      if (state.mode === "off") return { status: "pass", detail: "off" };
      return { status: "pass", detail: policy };
    },
  },
  {
    id: "backend",
    label: "backend",
    severity: "comms",
    optional: true,
    fix: { kind: "reconnect" },
    check: (ctx) => {
      const b = ctx.backend();
      if (b.status === "checking")
        return { status: "warn", detail: "checking" + glyph("ellipsis") };
      if (b.status === "unreachable")
        return {
          status: "warn",
          detail: "unreachable",
          hint: "the kernel did not respond " + glyph("emDash") + " reconnect the backend",
        };
      return { status: "pass", detail: `${b.profileCount ?? 0} Agent Profiles` };
    },
  },
  {
    id: "diagnostics",
    label: "diagnostics",
    severity: "ui",
    optional: true,
    /**
     * Report the diagnostic channel's state and, when it is open, its path.
     *
     * @remarks A `warn` while recording is deliberate and is not a complaint:
     * `ui` severity never blocks startup, and `warn` is the only status the
     * doctor keeps on screen without `show details`. That is the whole point —
     * the file's path is printed once to stderr before the renderer takes the
     * terminal, so by the time a user wants it, it has scrolled away.
     */
    check: () => {
      const session = activeDiagnosticSession();
      if (session === undefined)
        return {
          status: "pass",
          detail: "off",
          hint: "run with --debug, or open a session here with /debug",
        };
      return {
        status: "warn",
        detail: `recording at ${session.level}`,
        hint: session.path,
      };
    },
  },
];

/**
 * Run one gate, timing it and turning a throw into a visible failure.
 *
 * @param gate - the gate to evaluate.
 * @param ctx - the configuration it reads.
 * @returns the gate's result, or a synthetic `fail` describing the throw.
 * @remarks Twelve probes ran here with no instrumentation at all: one that
 *   threw took the whole readiness screen with it and left no record of which
 *   check it was, and a slow one left no record of anything. The result is
 *   degraded rather than propagated because the doctor is precisely the screen
 *   a user opens when something is already wrong.
 */
function checkGate(gate: Gate, ctx: DoctorCtx): GateResult {
  const startedAt = Date.now();
  try {
    return gate.check(ctx);
  } catch (error) {
    return reportGateFailure(gate, error, Date.now() - startedAt);
  }
}

/**
 * Record a gate that threw and stand in a failing result for it.
 *
 * @param gate - the gate that threw.
 * @param error - what it threw.
 * @param durationMs - how long it ran before throwing.
 * @returns the substitute {@link GateResult} the doctor renders.
 */
function reportGateFailure(gate: Gate, error: unknown, durationMs: number): GateResult {
  diagnosticEvent(
    "doctor.check.failed",
    { check_id: gate.id, error, duration_ms: durationMs },
    "error",
  );
  return {
    status: "fail",
    detail: `check failed: ${errorText(error)}`,
    hint: "this is a Clarvis defect; run with --debug and report the diagnostic log",
  };
}

/**
 * Runs every {@link GATES} entry against `ctx` and decides whether startup is blocked.
 *
 * @remarks Startup is blocked when any `hard`-severity gate fails, or any
 * `soft`-severity gate is not passing; `ui`/`comms` gates never block.
 */
export function runGates(ctx: DoctorCtx): DoctorReport {
  const results = {} as Record<GateId, GateResult>;
  for (const g of GATES) results[g.id] = checkGate(g, ctx);
  const blocked = GATES.some((g) => {
    const r = results[g.id];
    if (g.severity === "hard") return r.status === "fail";
    if (g.severity === "soft") return r.status !== "pass";
    return false;
  });
  return { gates: GATES, results, blocked };
}

/** Whether a {@link DoctorReport} should route the app to the doctor screen or straight to the shell. */
export function bootGate(report: DoctorReport): "shell" | "doctor" {
  return report.blocked ? "doctor" : "shell";
}

/** Startup destination that keeps first-run setup and damaged-install recovery out of Doctor. */
export type StartupRoute = "shell" | "setup" | "repair";

/** Classify startup from operational state rather than using the diagnostic screen as a wizard. */
export function startupRoute(ctx: DoctorCtx, report: DoctorReport): StartupRoute {
  if (!report.blocked) return "shell";
  const globalCorrupt = ctx.settings.corrupt("global");
  const workspaceCorrupt = ctx.settings.corrupt("workspace");
  if (globalCorrupt != null || workspaceCorrupt != null) return "repair";
  const noSettings =
    ctx.settings.read("global") === undefined && ctx.settings.read("workspace") === undefined;
  const noProviders = (ctx.settings.effective().providers?.length ?? 0) === 0;
  return noSettings || noProviders ? "setup" : "repair";
}
