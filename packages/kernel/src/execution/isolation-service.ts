import { createHash } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentExecutionResolver } from "@clarvis/loop/host";
import type { ExecuteRunArgs, ExecuteRunOutcome } from "@clarvis/loop";
import type { ConfigStore } from "../config/config-store.ts";
import type { AgentToolsOptions, ToolExecutionPort } from "@clarvis/tools";
import type {
  ActionAuthorizationPort,
  ActionAuthorizationRequest,
  ModelExecutionResolver,
} from "@clarvis/capability";
import { RUN_TRACE_PORT } from "@clarvis/capability";
import {
  analyzeShell,
  canSuggestRememberedAllow,
  evaluateCommand,
  parseApprovalPolicy,
  parseRuleDocument,
  ruleDigest,
} from "@clarvis/execpolicy";
import { globalPaths } from "@clarvis/paths";
import { loadExecutionRules, writeExecutionRules } from "./execpolicy-loader.ts";
import { createApprovalService } from "./approval-service.ts";
import { resolveApprovalMode } from "../config/approval-settings.ts";
import { judgeSettingsSchema, type JudgeSettings } from "../config/judge-settings.ts";
import { createRunJudge, runAuthorizationEvidence } from "./judge-service.ts";
import type { AuthorizationEvidence } from "@clarvis/judge";
import {
  executionRequirementsSchema,
  type ExecutionRequirements,
} from "../config/execution-requirements.ts";
import {
  resolveIsolationSettings,
  type ResolvedIsolationSettings,
} from "../config/isolation-settings.ts";

/** A private, owner-scoped snapshot of the global execution preference. */
export interface IsolationService {
  bind(owner: string, executionId: string, settings?: ResolvedIsolationSettings): void;
  inherit(owner: string, parentExecutionId: string, executionId: string): void;
  release(owner: string, executionId: string): void;
  resolveExecution: AgentExecutionResolver;
  resolveAuthorization(
    ctx: Parameters<AgentExecutionResolver>[0],
  ): Promise<ActionAuthorizationPort>;
  steer(
    owner: string,
    executionId: string,
    message?: string,
    authorizedDenial?: { call_id: string; attempt: number },
  ): void;
  availability: () => "available" | "unavailable" | "unverified";
  setModelExecutionResolver(resolver: ModelExecutionResolver | undefined): void;
  evidence(owner: string, executionId: string): readonly AuthorizationEvidence[];
}

/** Bind an internal run that bypasses the public run service for its entire execution. */
export async function executeWithIsolationBinding(
  service: IsolationService | undefined,
  args: ExecuteRunArgs,
  execute: (args: ExecuteRunArgs) => Promise<ExecuteRunOutcome>,
): Promise<ExecuteRunOutcome> {
  if (service === undefined) return execute(args);
  const body = args.rawBody;
  const executionId =
    typeof body === "object" && body !== null && "execution_id" in body
      ? body.execution_id
      : undefined;
  if (typeof executionId !== "string" || executionId.length === 0) {
    throw new Error("internal run isolation binding requires an execution id");
  }
  service.bind(args.owner, executionId);
  try {
    return await execute(args);
  } finally {
    service.release(args.owner, executionId);
  }
}

/** Bind each admitted tree before tool activation; a missing identity is never a global lookup. */
export function createIsolationService(options: {
  store: ConfigStore;
  workspaceRoot: string;
  globalRoot: string;
  homeRoot?: string;
  productRoot?: string;
}): IsolationService {
  const bindings = new Map<
    string,
    {
      settings: ResolvedIsolationSettings;
      approvalMode: "manual" | "auto";
      judge: JudgeSettings;
      approvalPolicy: ReturnType<typeof parseApprovalPolicy>;
      requirements: ExecutionRequirements;
      revision: { current: number };
      evidence: AuthorizationEvidence[];
      denials: Map<string, { action: ActionAuthorizationRequest; reason: string }>;
      pendingRetry?: { action: ActionAuthorizationRequest; evidence: AuthorizationEvidence };
    }
  >();
  const availabilityByNetwork = new Map<
    ResolvedIsolationSettings["network"],
    "available" | "unavailable"
  >();
  const authorizations = new Map<string, Promise<ActionAuthorizationPort>>();
  let modelExecutionResolver: ModelExecutionResolver | undefined;
  const key = (owner: string, executionId: string): string => `${owner}\0${executionId}`;
  const denialKey = (callId: string, attempt: number): string => `${callId}\0${attempt}`;
  const sameAction = (
    left: ActionAuthorizationRequest,
    right: ActionAuthorizationRequest,
  ): boolean =>
    left.tool === right.tool &&
    left.cwd === right.cwd &&
    left.command === right.command &&
    left.requestedProfile === right.requestedProfile &&
    left.effectiveProfile === right.effectiveProfile &&
    JSON.stringify(left.arguments) === JSON.stringify(right.arguments) &&
    JSON.stringify(left.permissions) === JSON.stringify(right.permissions) &&
    (left.identity.callId !== right.identity.callId ||
      left.identity.attempt < right.identity.attempt);
  const readGlobal = (): ResolvedIsolationSettings =>
    resolveIsolationSettings(options.store.readSettings().scopes.global?.isolation);
  const resolveAuthorization: IsolationService["resolveAuthorization"] = (ctx) => {
    const identity = key(ctx.owner, ctx.executionId);
    const existing = authorizations.get(identity);
    if (existing) return existing;
    const binding = bindings.get(identity);
    if (!binding) throw new Error("run isolation binding is missing");
    if (binding.evidence.length === 0) {
      const prior = ctx.priorState?.["action-authorization"];
      if (Array.isArray(prior)) {
        for (const item of prior) {
          if (
            typeof item === "object" &&
            item !== null &&
            ["user", "developer", "host", "workspace", "tool", "assistant"].includes(
              (item as { role?: string }).role ?? "",
            ) &&
            typeof (item as { content?: unknown }).content === "string"
          )
            binding.evidence.push({
              role: (item as AuthorizationEvidence).role,
              content: (item as AuthorizationEvidence).content,
            });
        }
      }
      binding.evidence.push(...runAuthorizationEvidence(ctx));
    }
    const pending = (async () => {
      const rules = await loadExecutionRules({
        globalDir: options.globalRoot,
        workspaceRoot: options.workspaceRoot,
        workspaceTrusted: options.store.readSettings().workspace_trust?.state === "trusted",
      });
      if (rules.status === "io_failure") throw new Error(rules.warning);
      const currentMode = (): "manual" | "auto" => {
        const mode = resolveApprovalMode(options.store.readSettings().scopes.global?.approval_mode);
        if (mode !== binding.approvalMode) {
          binding.approvalMode = mode;
          binding.revision.current++;
        }
        return mode;
      };
      const policyRevision = () =>
        createHash("sha256")
          .update(
            JSON.stringify({
              settings: binding.settings,
              approvalPolicy: binding.approvalPolicy,
              approvalMode: currentMode(),
              judge: binding.judge,
              requirements: binding.requirements,
              rules: rules.sources.map((source) => source.digest),
            }),
          )
          .digest("hex");
      let runJudge: ReturnType<typeof createRunJudge> | undefined;
      return createApprovalService({
        owner: ctx.owner,
        executionId: ctx.executionId,
        policy: binding.approvalPolicy,
        sources: rules.sources,
        elicit: ctx.elicit,
        revision: () => {
          currentMode();
          return binding.revision.current;
        },
        backendAvailable: availabilityByNetwork.get(binding.settings.network) !== "unavailable",
        policyRevision,
        denyRead: (binding.requirements.deny_read_paths?.length ?? 0) > 0,
        trace: ctx.services?.get(RUN_TRACE_PORT),
        mode: currentMode,
        judgeRequired: binding.requirements.judge_required,
        strictReview: binding.requirements.strict_review,
        rememberPrefix: async (request, prefix) => {
          if (request.authorizationRevision !== binding.revision.current) return false;
          if (!request.command || !canSuggestRememberedAllow(prefix)) return false;
          const analysis = analyzeShell(request.command);
          if (
            analysis.limit !== "none" ||
            analysis.segments.length !== 1 ||
            JSON.stringify(analysis.segments[0]) !== JSON.stringify(prefix)
          )
            return false;
          const current = await loadExecutionRules({
            globalDir: options.globalRoot,
            workspaceRoot: options.workspaceRoot,
            workspaceTrusted: options.store.readSettings().workspace_trust?.state === "trusted",
          });
          if (current.status !== "loaded") return false;
          const check = evaluateCommand({
            command: request.command,
            cwd: request.cwd ?? options.workspaceRoot,
            sources: current.sources,
            approval_policy: binding.approvalPolicy,
            backend_available:
              availabilityByNetwork.get(binding.settings.network) !== "unavailable",
            restricted: request.effectiveProfile === "sandbox",
            path: request.environment?.PATH,
          });
          if (
            check.decision === "forbidden" ||
            check.matches.some((match) => match.decision !== "allow")
          )
            return false;
          const file = globalPaths(options.globalRoot).executionRulesFile;
          let bytes: string | undefined;
          try {
            bytes = await readFile(file, "utf8");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          const document = bytes
            ? parseRuleDocument(JSON.parse(bytes) as unknown)
            : { version: 1 as const, rules: [] };
          if (
            document.rules.some(
              (rule) =>
                rule.decision === "allow" &&
                JSON.stringify(rule.pattern) === JSON.stringify(prefix),
            )
          )
            return true;
          document.rules.push({
            id: `remembered-${createHash("sha256").update(JSON.stringify(prefix)).digest("hex").slice(0, 16)}`,
            pattern: [...prefix],
            decision: "allow",
            justification: "Operator remembered this argv prefix",
          });
          await writeExecutionRules({
            globalDir: options.globalRoot,
            workspaceRoot: options.workspaceRoot,
            workspaceTrusted: true,
            scope: "global",
            operatorAction: true,
            expectedRevision: bytes === undefined ? null : ruleDigest(bytes),
            validateBeforeCommit: () => request.authorizationRevision === binding.revision.current,
            document,
          });
          return true;
        },
        judge: {
          review(input, signal) {
            runJudge ??= createRunJudge(ctx, binding.judge, modelExecutionResolver, {
              workspaceRoot: options.workspaceRoot,
              globalRoot: options.globalRoot,
              ...(options.homeRoot ? { homeRoot: options.homeRoot } : {}),
              ...(options.productRoot ? { productRoot: options.productRoot } : {}),
              denyReadPaths: binding.requirements.deny_read_paths,
            });
            return runJudge.review(input, signal);
          },
        },
        authorizationEvidence: (request: ActionAuthorizationRequest) => [
          ...binding.evidence,
          ...(binding.pendingRetry && sameAction(binding.pendingRetry.action, request)
            ? [binding.pendingRetry.evidence]
            : []),
        ],
        onJudgeReviewed: (request: ActionAuthorizationRequest) => {
          if (binding.pendingRetry && sameAction(binding.pendingRetry.action, request))
            binding.pendingRetry = undefined;
        },
        onJudgeDenied: (request: ActionAuthorizationRequest, reason: string) => {
          binding.denials.set(denialKey(request.identity.callId, request.identity.attempt), {
            action: request,
            reason,
          });
        },
        fallback: binding.judge.fallback ?? "manual_on_context_overflow",
      });
    })();
    authorizations.set(identity, pending);
    pending.catch(() => {
      if (authorizations.get(identity) === pending) authorizations.delete(identity);
    });
    return pending;
  };
  return {
    resolveAuthorization,
    evidence(owner, executionId) {
      return [...(bindings.get(key(owner, executionId))?.evidence ?? [])];
    },
    setModelExecutionResolver(resolver) {
      modelExecutionResolver = resolver;
    },
    steer(owner, executionId, message, authorizedDenial) {
      const binding = bindings.get(key(owner, executionId));
      if (binding) {
        if (authorizedDenial) {
          const deniedKey = denialKey(authorizedDenial.call_id, authorizedDenial.attempt);
          const denial = binding.denials.get(deniedKey);
          if (!denial) throw new Error("denied action is unavailable for authorization");
          binding.denials.delete(deniedKey);
          binding.pendingRetry = {
            action: denial.action,
            evidence: {
              role: "user",
              content: `The operator authorized one new attempt of this denied action: ${JSON.stringify({ tool: denial.action.tool, arguments: denial.action.arguments, cwd: denial.action.cwd, permissions: denial.action.permissions })}. Previous denial: ${denial.reason}`,
            },
          };
        }
        binding.revision.current += 1;
        if (message && !authorizedDenial) binding.evidence.push({ role: "user", content: message });
      }
    },
    availability: () => availabilityByNetwork.get(readGlobal().network) ?? "unverified",
    bind(owner, executionId, settings = readGlobal()) {
      const identity = key(owner, executionId);
      if (bindings.has(identity)) throw new Error("isolation binding already exists");
      const snapshot = options.store.readSettings();
      const globalError = snapshot.sources.find((source) => source.scope === "global")?.error;
      if (globalError) throw new Error(`Invalid global execution settings: ${globalError}`);
      const operator = snapshot.scopes.global;
      bindings.set(identity, {
        settings: { ...settings },
        approvalMode: resolveApprovalMode(operator?.approval_mode),
        judge: judgeSettingsSchema.parse(operator?.judge ?? {}),
        approvalPolicy: parseApprovalPolicy(operator?.approval_policy ?? "on-request"),
        requirements: executionRequirementsSchema.parse(operator?.execution_requirements ?? {}),
        revision: { current: 0 },
        evidence: [],
        denials: new Map(),
      });
    },
    inherit(owner, parentExecutionId, executionId) {
      const parent = bindings.get(key(owner, parentExecutionId));
      if (!parent) throw new Error("parent isolation binding is missing");
      const identity = key(owner, executionId);
      if (bindings.has(identity)) throw new Error("isolation binding already exists");
      bindings.set(identity, {
        ...parent,
        settings: { ...parent.settings },
        evidence: [...parent.evidence],
        denials: new Map(parent.denials),
      });
    },
    release(owner, executionId) {
      bindings.delete(key(owner, executionId));
      authorizations.delete(key(owner, executionId));
    },
    async resolveExecution(ctx, scratchRoot) {
      const binding = bindings.get(key(ctx.owner, ctx.executionId));
      if (!binding) throw new Error("run isolation binding is missing");
      const settings = binding.settings;
      const [{ createExecutionPolicy, BubblewrapBackend, SeatbeltBackend }, tools] =
        await Promise.all([import("@clarvis/sandbox"), import("@clarvis/tools")]);
      const policy = createExecutionPolicy({
        id: createHash("sha256").update(key(ctx.owner, ctx.executionId)).digest("hex").slice(0, 32),
        mode: settings.mode,
        workspaceRoot: options.workspaceRoot,
        globalRoot: options.globalRoot,
        ...(options.homeRoot === undefined ? {} : { homeRoot: options.homeRoot }),
        workspaceAccess: settings.workspace,
        network: settings.network,
        temporaryWriteRoots: [scratchRoot],
        additionalWriteRoots: settings.additional_write_roots,
        readOnlyPaths: binding.requirements.read_only_paths,
        denies: binding.requirements.deny_read_paths,
        installationRoots: [
          dirname(realpathSync(process.execPath)),
          ...(existsSync(tools.sandboxWorkerRoot) ? [tools.sandboxWorkerRoot] : []),
          ...(options.productRoot && existsSync(options.productRoot) ? [options.productRoot] : []),
        ],
      });
      const backend =
        process.platform === "darwin" ? new SeatbeltBackend() : new BubblewrapBackend();
      const approval = await resolveAuthorization(ctx);
      const sandbox =
        settings.mode === "sandbox"
          ? new tools.SandboxToolExecutor(policy, backend, scratchRoot)
          : undefined;
      const defaultPort = sandbox
        ? new tools.CoordinatedToolExecutor(sandbox, (ready) => {
            availabilityByNetwork.set(settings.network, ready ? "available" : "unavailable");
          })
        : tools.hostToolExecutor;
      const selectAuthorizedExecution: NonNullable<
        AgentToolsOptions["selectAuthorizedExecution"]
      > = (permissions) => {
        if (!permissions || settings.mode === "host")
          return { executionPort: defaultPort, executionPolicy: policy };
        if (permissions.host) {
          if (policy.denies.length)
            throw new Error("Host cannot preserve explicit deny-read restrictions");
          return {
            executionPort: tools.hostToolExecutor,
            sandboxBackend: undefined,
            executionPolicy: createExecutionPolicy({
              id: `${policy.id}.host`,
              mode: "host",
              workspaceRoot: policy.workspaceRoot,
              globalRoot: policy.globalRoot,
              homeRoot: policy.homeRoot,
              installationRoots: policy.installationRoots,
              temporaryWriteRoots: policy.temporaryWriteRoots,
            }),
          };
        }
        const scoped = createExecutionPolicy({
          id: createHash("sha256")
            .update(`${policy.id}:${JSON.stringify(permissions)}`)
            .digest("hex")
            .slice(0, 32),
          mode: "sandbox",
          workspaceRoot: policy.workspaceRoot,
          globalRoot: policy.globalRoot,
          homeRoot: policy.homeRoot,
          workspaceAccess: policy.workspaceAccess,
          network: permissions.network ?? policy.network,
          temporaryWriteRoots: policy.temporaryWriteRoots,
          installationRoots: policy.installationRoots,
          additionalWriteRoots: [
            ...policy.additionalWriteRoots,
            ...(permissions.writeRoots ?? []).filter(
              (root) => existsSync(root) && statSync(root).isDirectory(),
            ),
          ],
          readOnlyPaths: binding.requirements.read_only_paths,
          writableMetadataRoots: (permissions.writeRoots ?? []).filter(
            (root) =>
              policy.readOnlyPaths.includes(root) &&
              !binding.requirements.read_only_paths?.includes(root),
          ),
          denies: policy.denies,
        });
        const oneShot = new tools.SandboxToolExecutor(scoped, backend, scratchRoot);
        const executionPort: ToolExecutionPort = {
          async execute(tool, args, config, signal) {
            try {
              return await oneShot.execute(tool, args, config, signal);
            } finally {
              await oneShot.close();
            }
          },
        };
        return { executionPolicy: scoped, executionPort };
      };
      return {
        executionPolicy: policy,
        ...(settings.mode === "sandbox" ? { sandboxBackend: backend } : {}),
        executionPort: defaultPort,
        actionAuthorization: approval,
        actionIdentity: { owner: ctx.owner, executionId: ctx.executionId },
        selectAuthorizedExecution,
      };
    },
  };
}
