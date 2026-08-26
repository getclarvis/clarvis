import {
  type CapabilityExecutableDeclaration,
  type CapabilityExecutablePort,
  type CapabilityExecutableSession,
} from "@clarvis/capability";

import {
  assertProviderVocabulary,
  MEMORY_READ_TOOL_NAMES,
  MEMORY_WRITE_TOOL_NAMES,
  type MemoryProvider,
} from "./provider.ts";
import {
  MEMORY_TOOL_CONTRACTS,
  memoryToolParameters,
  type MemoryToolName,
} from "./tool-contract.ts";
import type { MemoryToolDef, MemoryToolResult } from "./types.ts";

export const EXECUTABLE_MEMORY_PROVIDER_KIND = "executable";

export interface ExecutableMemoryProviderOptions {
  declaration: CapabilityExecutableDeclaration;
  cwd: string;
  workspaceRoot: string;
  owner: string;
  port: CapabilityExecutablePort;
}

function resultOf(value: unknown): MemoryToolResult {
  if (typeof value !== "object" || value === null) {
    throw new Error("memory executable method must return { text, isError }");
  }
  const result = value as Record<string, unknown>;
  if (typeof result.text !== "string" || typeof result.isError !== "boolean") {
    throw new Error("memory executable method must return { text, isError }");
  }
  return { text: result.text, isError: result.isError };
}

function toolFor(
  name: MemoryToolName,
  owner: string,
  session: CapabilityExecutableSession,
): MemoryToolDef {
  return {
    name,
    description: MEMORY_TOOL_CONTRACTS[name].description,
    parameters: memoryToolParameters(name),
    async execute(args, signal): Promise<MemoryToolResult> {
      try {
        return resultOf(await session.request(`memory/${name}`, { owner, ...args }, signal));
      } catch (error) {
        return {
          text: `memory provider failed: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        };
      }
    },
  };
}

/** Adapt a persistent language-neutral executable to Clarvis's Memory vocabulary. */
export async function createExecutableMemoryProvider(
  options: ExecutableMemoryProviderOptions,
): Promise<MemoryProvider> {
  const session = await options.port.session({
    capability: "memory",
    workspace: options.workspaceRoot,
    cwd: options.cwd,
    declaration: options.declaration,
    owner: options.owner,
  });
  const provider: MemoryProvider = {
    kind: session.providerKind,
    readTools: MEMORY_READ_TOOL_NAMES.map((name) => toolFor(name, options.owner, session)),
    ...(session.writable === true
      ? {
          writeTools: MEMORY_WRITE_TOOL_NAMES.map((name) => toolFor(name, options.owner, session)),
        }
      : {}),
    async seed(task?: string): Promise<string | null> {
      const value = await session.request("memory/seed", {
        owner: options.owner,
        task: task ?? "",
      });
      if (value === null || value === undefined) return null;
      if (typeof value !== "string") throw new Error("memory/seed must return a string or null");
      const body = value.trim();
      return body.length === 0 ? null : body;
    },
  };
  assertProviderVocabulary(provider);
  return provider;
}
