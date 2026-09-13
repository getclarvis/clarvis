import type { RunRequest } from "@clarvis/loop";
import type { StartRunParams } from "@clarvis/protocol";
import type { AgentRecord } from "../config/config-store.ts";
import { kernelError } from "../core/errors.ts";
import type { RuntimeToolPolicy } from "./tool-policy.ts";
import { RuntimeLaunchError } from "./types.ts";

/** Host-owned, closed description of the authority admitted to a container guest. */
export interface ContainerCorePolicy {
  readonly revision: 1;
  readonly toolPolicy: RuntimeToolPolicy;
  readonly network: "none" | "outbound";
  readonly gitMetadata: "absent" | "read-only";
  readonly commandReview: "off";
  readonly hostFeatures: "none";
}

/** Materialize the fixed host-owned policy for one admitted Container run. */
export function containerCorePolicy(input: {
  readonly toolPolicy: RuntimeToolPolicy;
  readonly network: "none" | "outbound";
  readonly gitMetadata: "absent" | "read-only";
}): ContainerCorePolicy {
  return {
    revision: 1,
    toolPolicy: input.toolPolicy,
    network: input.network,
    gitMetadata: input.gitMetadata,
    commandReview: "off",
    hostFeatures: "none",
  };
}

/** The complete host-capability broker surface available to a core-only container guest. */
export const CONTAINER_CORE_CAPABILITY_METHODS = ["runtime.elicit"] as const;

/** Grants implemented wholly by the guest loop and its confined builtin tools. */
export const CONTAINER_CORE_GRANTS = [
  "ask_user",
  "read_workspace",
  "edit_workspace",
  "run_commands",
] as const;

/** Request fields whose presence would reintroduce native or extension-backed behavior. */
export const CONTAINER_FORBIDDEN_REQUEST_FIELDS = [
  "hostCapabilities",
  "skill",
  "skillCatalog",
  "skillBootstraps",
  "hooks",
  "hook_user_prompt_expansion",
  "plans",
  "memory",
  "task",
  "workflow",
  "goal",
  "parentRunId",
  "outputBudgets",
  "guard_mode",
  "guard_judge",
] as const;

const CORE_GRANTS = new Set<string>(CONTAINER_CORE_GRANTS);
const PROJECTED_BUILTINS = new Set(["marshall", "coder", "explorer", "planner"]);

interface ContainerAdmissionSource {
  readEffectiveAgent(name: string): AgentRecord | null;
}

function unavailable(capability: string): never {
  throw kernelError(
    "unsupported",
    `${capability} is unavailable in Isolation Container. Use Isolation Sandbox or Host.`,
    { placement: "container", capability },
  );
}

function profileCapability(grants: readonly string[]): string | undefined {
  if (grants.includes("workflow")) return "Workflow";
  if (grants.includes("use_skills")) return "Skills";
  const capabilityGrant = grants.find((grant) => !CORE_GRANTS.has(grant));
  return capabilityGrant === undefined ? undefined : capabilityGrant;
}

/** Defensively validate the already-admitted request at the runtime authority boundary. */
export function assertContainerCoreRuntimeRequest(value: unknown): asserts value is RunRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new RuntimeLaunchError("unsupported_policy", "Container run request is invalid");
  const body = value as RunRequest & Record<string, unknown>;
  if (
    CONTAINER_FORBIDDEN_REQUEST_FIELDS.some((field) => field in body) ||
    !Array.isArray(body.servers) ||
    body.servers.length !== 0 ||
    !Array.isArray(body.profiles) ||
    body.profiles.some(
      (profile) =>
        !Array.isArray(profile.tools) ||
        profile.tools.length !== 0 ||
        (profile.grants ?? []).some(
          (grant) => !(CONTAINER_CORE_GRANTS as readonly string[]).includes(grant),
        ),
    )
  )
    throw new RuntimeLaunchError(
      "unsupported_policy",
      "container runtime received a request outside the admitted core surface",
    );
}

/** Refuse an explicit feature request before assembly can resolve or load extension content. */
export function assertContainerCoreExplicitRequest(
  params: StartRunParams,
  options: { goalRequested: boolean; resolvedSkillMention?: boolean },
): void {
  if (params.skill !== undefined || options.resolvedSkillMention === true) unavailable("Skills");
  if (params.task !== undefined) unavailable("Tasks");
  if (params.plans !== undefined) unavailable("Plans");
  if (params.memory !== undefined) unavailable("Memory");
  if (
    params.guard_mode === "on" ||
    params.guard_mode === "auto" ||
    params.guard_judge !== undefined
  )
    unavailable("Command Review");
  if (options.goalRequested) unavailable("Goal");
}

/**
 * Admit and project one assembled request to the fixed Container core surface.
 *
 * Explicit feature requests fail before workflow routing, run reservation, engine acquisition or
 * inference. Inherited host-wide settings are projected away. A custom assembler receives no
 * provenance exemption: feature fields it adds are treated as explicit and refused.
 */
export function admitContainerCoreRun(input: {
  params: StartRunParams;
  assembled: unknown;
  source: ContainerAdmissionSource;
  customAssembler: boolean;
  goalRequested: boolean;
}): RunRequest {
  assertContainerCoreExplicitRequest(input.params, { goalRequested: input.goalRequested });
  if (
    typeof input.assembled !== "object" ||
    input.assembled === null ||
    Array.isArray(input.assembled)
  )
    throw kernelError("invalid_request", "prepared run assembler returned no request object");

  const body = structuredClone(input.assembled) as RunRequest & Record<string, unknown>;
  if (!Array.isArray(body.profiles))
    throw kernelError("invalid_request", "prepared run has no profile graph");
  if (input.customAssembler) {
    if (body.skillCatalog !== undefined || body.skillBootstraps !== undefined)
      unavailable("Skills");
    if (body.hooks !== undefined || body.hook_user_prompt_expansion !== undefined)
      unavailable("Hooks");
    if (body.workflow !== undefined || body.parentRunId !== undefined) unavailable("Workflow");
    if (body.goal !== undefined) unavailable("Goal");
    if (body.plans !== undefined) unavailable("Plans");
    if (body.memory !== undefined) unavailable("Memory");
    if (body.task !== undefined) unavailable("Tasks");
    if (body.guard_mode === "on" || body.guard_mode === "auto" || body.guard_judge !== undefined)
      unavailable("Command Review");
  }

  const names = new Set(body.profiles.map((profile) => profile.name));
  const projected = body.profiles.map((profile) => {
    const record = input.source.readEffectiveAgent(profile.name);
    if (record === null)
      throw kernelError(
        "unsupported",
        `Agent Profile '${profile.name}' is unavailable in Isolation Container. Use Isolation Sandbox or Host.`,
        { placement: "container", capability: "Agent Profile" },
      );
    if (record.scope === "plugin") unavailable(`Plugin Agent '${profile.name}'`);
    const declaredTools = record.frontmatter.tools;
    if (Array.isArray(declaredTools) && declaredTools.length > 0)
      unavailable(`MCP tools in Agent Profile '${profile.name}'`);
    if ((profile.tools ?? []).length > 0)
      unavailable(`MCP tools in Agent Profile '${profile.name}'`);

    const grants = [...(profile.grants ?? [])];
    const declaredGrants = Array.isArray(record.frontmatter.grants)
      ? record.frontmatter.grants.filter((grant): grant is string => typeof grant === "string")
      : [];
    if (record.scope === "builtin" && PROJECTED_BUILTINS.has(profile.name)) {
      const coreGrants = grants.filter((grant) => grant !== "use_skills");
      const incompatible = profileCapability(coreGrants);
      if (incompatible !== undefined) unavailable(incompatible);
      return { ...profile, grants: coreGrants };
    }
    const declaredIncompatible = profileCapability(declaredGrants);
    if (declaredIncompatible !== undefined) unavailable(declaredIncompatible);
    const incompatible = profileCapability(grants);
    if (incompatible !== undefined) unavailable(incompatible);
    return profile;
  });

  for (const profile of projected) {
    const defaultSpawn = profile.default_spawn;
    for (const child of [
      ...(profile.can_spawn ?? []),
      ...(typeof defaultSpawn === "string" ? [defaultSpawn] : []),
    ]) {
      if (!names.has(child))
        throw kernelError(
          "unsupported",
          `Agent Profile '${profile.name}' depends on unavailable profile '${child}' in Isolation Container. Use Isolation Sandbox or Host.`,
          { placement: "container", capability: "Agent Profile" },
        );
    }
  }

  body.profiles = projected;
  body.servers = [];
  delete body.guard_mode;
  delete body.guard_judge;
  delete body.hook_user_prompt_expansion;
  delete body.plans;
  delete body.memory;
  delete body.task;
  return body;
}
