import { randomUUID } from "node:crypto";

import {
  handlerBaseOf,
  openCallEnvelope,
  type AgentCapability,
  type Capability,
  type HandlerVerdict,
  type RunCapability,
  type ToolEffect,
  type ToolHandler,
  type Logger,
} from "@clarvis/capability";
import type { SkillInfo, SkillResource } from "@clarvis/skills";
import {
  LOAD_SKILL_TOOL_NAME,
  READ_SKILL_RESOURCE_TOOL_NAME,
  SKILL_RESOURCE_MAX_CHARS,
  loadSkillTool,
  readSkillResourceTool,
  renderSkillsSection,
  resolveBootstrapSkills,
  type PluginBootstrapSkill,
  type SkillsProvider,
} from "@clarvis/skills/capability";
import type { HostCapabilityGrant } from "./authority-brokers.ts";
import type { GuestExecutionBridge } from "./execution-worker.ts";

/** Exact private method used to disclose one host-admitted skill or resource. */
export const RUNTIME_SKILLS_METHOD = "runtime.skills";
export const RUNTIME_SKILLS_REVISION = "v1";

/** Host-path-free catalog row sent to the guest at run admission. */
export interface RuntimeSkillCatalogEntry {
  readonly name: string;
  readonly description: string;
  readonly scope: "user" | "workspace";
  readonly source: string;
  readonly catalogSuppressed?: boolean;
  readonly dependencies?: SkillInfo["dependencies"];
}

/** Plugin bootstrap body already admitted by the host without its source roots. */
export interface RuntimeSkillBootstrapEntry {
  readonly plugin: string;
  readonly skill: string;
  readonly body: string;
}

type SkillBridgeRequest =
  | { readonly operation: "load"; readonly name: string }
  | {
      readonly operation: "resource";
      readonly name: string;
      readonly resource: string;
      readonly offset: number;
    };

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function exactly(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const admitted = new Set(keys);
  const present = Object.keys(value);
  return present.length === keys.length && present.every((key) => admitted.has(key));
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function safeResource(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 4_096) return false;
  return (
    !value.startsWith("/") &&
    !/^[A-Za-z]:/u.test(value) &&
    !value.includes("\\") &&
    !hasControlCharacter(value) &&
    value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
}

function validSkillRequest(
  value: unknown,
  names: ReadonlySet<string>,
): value is SkillBridgeRequest {
  const request = record(value);
  if (request === undefined || typeof request.name !== "string" || !names.has(request.name)) {
    return false;
  }
  if (request.operation === "load") {
    return exactly(request, ["operation", "name"]);
  }
  return (
    request.operation === "resource" &&
    exactly(request, ["operation", "name", "resource", "offset"]) &&
    safeResource(request.resource) &&
    Number.isSafeInteger(request.offset) &&
    (request.offset as number) >= 0 &&
    (request.offset as number) <= 8 * 1024 * 1024
  );
}

function runtimePath(name: string): string {
  return `/runtime/skills/${name}`;
}

function runtimeSource(source: string): string {
  return /^(?:clarvis|agents|plugin:[A-Za-z0-9._-]+)$/u.test(source) ? source : "runtime";
}

/** Project only model-relevant metadata, replacing every host path with a guest-only locator. */
export function createRuntimeSkillCatalog(provider: SkillsProvider): RuntimeSkillCatalogEntry[] {
  return provider.listSkills().map((skill) => ({
    name: skill.name,
    description: skill.description,
    scope: skill.scope,
    source: runtimeSource(skill.source),
    ...(skill.catalogSuppressed === undefined
      ? {}
      : { catalogSuppressed: skill.catalogSuppressed }),
    ...(skill.dependencies === undefined
      ? {}
      : {
          dependencies: skill.dependencies.map((dependency) => ({
            type: "mcp" as const,
            value: dependency.value,
          })),
        }),
  }));
}

/** Resolve only active plugins' bootstrap skills and remove every host-only root from the result. */
export function createRuntimeSkillBootstraps(
  provider: SkillsProvider,
  load: (() => readonly PluginBootstrapSkill[]) | undefined,
  logger?: Logger,
): RuntimeSkillBootstrapEntry[] {
  let refs: readonly PluginBootstrapSkill[];
  try {
    refs = load?.() ?? [];
  } catch (error) {
    logger?.warn(
      { cause: error instanceof Error ? error.message : String(error) },
      "bootstrap_skills_unavailable: could not read the plugins' declared bootstrap skills",
    );
    return [];
  }
  return resolveBootstrapSkills({
    refs,
    loadSkill: (name) => provider.loadSkill(name),
    ...(logger === undefined ? {} : { logger }),
  }).map(({ plugin, skill, body }) => ({ plugin, skill, body }));
}

/** Bind one run to read-only disclosure of the exact skill catalog admitted by its host. */
export function createHostSkillsGrant(
  provider: SkillsProvider,
  catalog: readonly RuntimeSkillCatalogEntry[],
): HostCapabilityGrant {
  const names = new Set(catalog.map((skill) => skill.name));
  return {
    method: RUNTIME_SKILLS_METHOD,
    revision: RUNTIME_SKILLS_REVISION,
    idempotent: true,
    validateArguments: (value) => validSkillRequest(value, names),
    async invoke(value) {
      if (!validSkillRequest(value, names)) {
        throw Object.assign(new Error("runtime skill request is invalid"), {
          code: "invalid_request",
        });
      }
      if (value.operation === "load") {
        const skill = provider.loadSkill(value.name);
        if (skill === undefined || skill.name !== value.name) return null;
        return {
          kind: "skill",
          name: skill.name,
          description: skill.description,
          body: skill.body,
          directory: runtimePath(skill.name),
          resources: skill.resources.flatMap((resource) =>
            safeResource(resource.rel) ? [{ kind: resource.kind, rel: resource.rel }] : [],
          ),
        };
      }
      const offset = value.offset;
      const chunk = provider.readResourceChunk?.(
        value.name,
        value.resource,
        offset,
        SKILL_RESOURCE_MAX_CHARS,
      );
      if (chunk !== undefined) {
        return {
          kind: "resource",
          name: value.name,
          resource: value.resource,
          chunk,
        };
      }
      if (offset !== 0) {
        throw Object.assign(new Error("skill provider does not support resource continuation"), {
          code: "invalid_request",
        });
      }
      const text = provider.readResource(value.name, value.resource);
      const sliced = text.slice(0, SKILL_RESOURCE_MAX_CHARS);
      return {
        kind: "resource",
        name: value.name,
        resource: value.resource,
        chunk: {
          text: sliced,
          offset: 0,
          totalBytes: Buffer.byteLength(text, "utf8"),
          ...(sliced.length < text.length ? { nextOffset: Buffer.byteLength(sliced, "utf8") } : {}),
        },
      };
    },
  };
}

function skillInfo(entry: RuntimeSkillCatalogEntry): SkillInfo {
  const directory = runtimePath(entry.name);
  return {
    name: entry.name,
    description: entry.description,
    metadata: { name: entry.name, description: entry.description },
    userInvocable: true,
    scope: entry.scope,
    source: entry.source,
    root: "/runtime/skills",
    dir: directory,
    path: `${directory}/SKILL.md`,
    ...(entry.catalogSuppressed === undefined
      ? {}
      : { catalogSuppressed: entry.catalogSuppressed }),
    ...(entry.dependencies === undefined ? {} : { dependencies: entry.dependencies }),
  };
}

function bodyResult(value: unknown): string | undefined {
  const result = record(value);
  if (
    result?.kind !== "skill" ||
    typeof result.name !== "string" ||
    typeof result.description !== "string" ||
    typeof result.body !== "string" ||
    typeof result.directory !== "string" ||
    !Array.isArray(result.resources)
  ) {
    return undefined;
  }
  const resources = result.resources.flatMap((value) => {
    const resource = record(value);
    return resource !== undefined &&
      typeof resource.rel === "string" &&
      (resource.kind === "scripts" ||
        resource.kind === "references" ||
        resource.kind === "assets" ||
        resource.kind === "examples" ||
        resource.kind === "other")
      ? [{ kind: resource.kind, rel: resource.rel } satisfies Pick<SkillResource, "kind" | "rel">]
      : [];
  });
  const resourceList =
    resources.length === 0
      ? ""
      : `\n\nBundled resources (call ${READ_SKILL_RESOURCE_TOOL_NAME} with name, the exact ` +
        `resource path, and offset=0):\n${resources
          .map((resource) => `- ${resource.rel} (${resource.kind})`)
          .join("\n")}`;
  return (
    `Skill '${result.name}' — ${result.description}\n\n` +
    `Skill directory: ${result.directory}\n` +
    "Resolve bundled relative paths from that directory.\n\n" +
    `${result.body.length > 0 ? result.body : "(this skill has an empty body)"}${resourceList}`
  );
}

function resourceResult(value: unknown, requestedOffset: number): string | undefined {
  const result = record(value);
  const chunk = record(result?.chunk);
  if (
    result?.kind !== "resource" ||
    typeof result.name !== "string" ||
    typeof result.resource !== "string" ||
    chunk === undefined ||
    typeof chunk.text !== "string" ||
    !Number.isSafeInteger(chunk.offset) ||
    chunk.offset !== requestedOffset ||
    !Number.isSafeInteger(chunk.totalBytes) ||
    (chunk.totalBytes as number) < 0 ||
    (chunk.nextOffset !== undefined && !Number.isSafeInteger(chunk.nextOffset))
  ) {
    return undefined;
  }
  const offset = chunk.offset;
  const totalBytes = chunk.totalBytes as number;
  const nextOffset = chunk.nextOffset as number | undefined;
  const continuation =
    nextOffset === undefined
      ? ""
      : `\n\n[resource continues; call ${READ_SKILL_RESOURCE_TOOL_NAME} with the same name and ` +
        `resource and offset=${String(nextOffset)}]`;
  return `Resource '${result.resource}' of skill '${result.name}' (bytes ${String(
    offset,
  )}-${String(nextOffset ?? totalBytes)} of ${String(totalBytes)}):\n\n${chunk.text}${continuation}`;
}

const SKILL_TOOL_EFFECTS: Readonly<Record<string, ToolEffect>> = {
  [LOAD_SKILL_TOOL_NAME]: "control",
  [READ_SKILL_RESOURCE_TOOL_NAME]: "control",
};

/** Create the guest capability over a sanitized catalog and read-only host disclosure method. */
export function createGuestSkillsCapability(
  catalog: readonly RuntimeSkillCatalogEntry[],
  bridge: GuestExecutionBridge,
  bootstraps: readonly RuntimeSkillBootstrapEntry[] = [],
): Capability {
  const listed = catalog.map(skillInfo);
  const names = new Set(listed.map((skill) => skill.name));
  return {
    name: "skills",
    grants: [{ name: "use_skills" }],
    reservedWireNames: [LOAD_SKILL_TOOL_NAME, READ_SKILL_RESOURCE_TOOL_NAME],
    toolEffects: SKILL_TOOL_EFFECTS,
    forRun(ctx): RunCapability | null {
      if (!ctx.env.CLARVIS_SKILLS_ENABLED) return null;
      const servers = new Set(ctx.request.servers.map((server) => server.name));
      const available = listed.filter((skill) => {
        const plugin = skill.source.startsWith("plugin:")
          ? skill.source.slice("plugin:".length)
          : undefined;
        return (skill.dependencies ?? []).every(
          (dependency) =>
            servers.has(dependency.value) ||
            (plugin !== undefined && servers.has(`${plugin}:${dependency.value}`)),
        );
      });
      const catalogFor = (grants: readonly string[]) =>
        grants.includes("use_skills") && available.length > 0 ? available : undefined;
      return {
        name: "skills",
        systemSection(identity): string | undefined {
          const selected = catalogFor(identity.grants);
          if (selected === undefined) return undefined;
          const section = renderSkillsSection([...selected], bootstraps);
          return section.length > 0 ? section : undefined;
        },
        forAgent(scope): AgentCapability | null {
          if (catalogFor(scope.grants) === undefined) return null;
          return {
            attach(build) {
              const base = handlerBaseOf(build);
              const handler: ToolHandler = {
                matches: (call) =>
                  call.name === LOAD_SKILL_TOOL_NAME || call.name === READ_SKILL_RESOURCE_TOOL_NAME,
                async handle(call, iteration): Promise<HandlerVerdict> {
                  const readsResource = call.name === READ_SKILL_RESOURCE_TOOL_NAME;
                  const tool = readsResource ? readSkillResourceTool : loadSkillTool;
                  const envelope = openCallEnvelope({
                    call,
                    name: tool.wireName,
                    trace: base.trace,
                    agent: base.agent,
                    ...(base.subagentInstanceId === undefined
                      ? {}
                      : { subagentInstanceId: base.subagentInstanceId }),
                    iteration,
                    schema: tool.inputSchema,
                    ...(base.validateArgs === undefined ? {} : { validate: base.validateArgs }),
                  });
                  if (envelope.invalid !== null) {
                    return {
                      kind: "result",
                      text: envelope.fail(envelope.invalid),
                      progress: false,
                    };
                  }
                  const args = call.arguments as {
                    name: string;
                    resource: string;
                    offset: number;
                  };
                  if (!names.has(args.name)) {
                    return {
                      kind: "result",
                      text: envelope.fail(
                        `unknown skill '${args.name}'. Available skills: ${[...names].join(", ") || "(none)"}.`,
                      ),
                      progress: false,
                    };
                  }
                  envelope.start();
                  try {
                    const value = await bridge.capability(
                      randomUUID(),
                      {
                        method: RUNTIME_SKILLS_METHOD,
                        revision: RUNTIME_SKILLS_REVISION,
                        arguments: readsResource
                          ? {
                              operation: "resource",
                              name: args.name,
                              resource: args.resource,
                              offset: args.offset,
                            }
                          : { operation: "load", name: args.name },
                      },
                      scope.signal,
                    );
                    const text = readsResource
                      ? resourceResult(value, args.offset)
                      : bodyResult(value);
                    if (text === undefined) {
                      return {
                        kind: "result",
                        text: envelope.fail(`skill '${args.name}' is no longer available.`),
                        progress: false,
                      };
                    }
                    return { kind: "result", text: envelope.ok(text), progress: true };
                  } catch (error) {
                    const reason = error instanceof Error ? error.message : String(error);
                    return {
                      kind: "result",
                      text: envelope.fail(
                        readsResource
                          ? `could not read resource '${args.resource}' of skill '${args.name}': ${reason}`
                          : `could not load skill '${args.name}': ${reason}`,
                      ),
                      progress: false,
                    };
                  }
                },
              };
              return {
                tools: [loadSkillTool, readSkillResourceTool],
                handlers: [handler],
                advertised: false,
              };
            },
          };
        },
      };
    },
  };
}
