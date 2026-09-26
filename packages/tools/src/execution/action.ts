import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { realpathSync, statSync } from "node:fs";
import { ToolError } from "../errors.ts";
import { statDirectory } from "../lib/files.ts";
import { resolveFileToolPath, resolvePath } from "../lib/paths.ts";
import { canonicalTarget } from "./canonical-target.ts";
import { patchTargets } from "../tools/apply-patch.ts";
import type { RuntimeConfig } from "../config.ts";

export interface ToolAction {
  readonly tool: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly command?: string;
  readonly shell?: string;
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly paths: readonly string[];
  readonly permissions?: {
    readonly writeRoots?: readonly string[];
    readonly network?: "enabled";
    readonly host?: boolean;
  };
  readonly reason: string;
}

function within(path: string, root: string): boolean {
  const suffix = relative(root, path);
  return (
    suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix))
  );
}

function existingWriteRoot(path: string): string {
  let root = dirname(path);
  while (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    const parent = dirname(root);
    if (parent === root) break;
    root = parent;
  }
  return root;
}

/** Resolve the same path vocabulary that handlers consume before an effect starts. */
export async function prepareToolAction(
  tool: string,
  args: Record<string, unknown>,
  config: RuntimeConfig,
): Promise<ToolAction> {
  if (tool === "shell") {
    const cwdArg = args.cwd as string | undefined;
    const cwd = cwdArg ? resolvePath(cwdArg, config.workspaceRoot) : config.workspaceRoot;
    await statDirectory(cwd, cwdArg ?? cwd);
    if (typeof args.ready_when === "string") {
      try {
        new RegExp(args.ready_when);
      } catch (error) {
        throw new ToolError(
          "invalid_input",
          `Invalid ready_when regex: ${(error as Error).message}`,
        );
      }
    }
    const request = args.execution_permissions as
      | {
          mode: "use_default" | "require_escalated" | "with_additional_permissions";
          write_roots?: string[];
          network?: "enabled";
        }
      | undefined;
    if (
      request?.mode === "with_additional_permissions" &&
      !request.network &&
      !request.write_roots?.length
    ) {
      throw new ToolError(
        "invalid_input",
        "Additional permissions require a network or write root delta",
      );
    }
    for (const root of request?.write_roots ?? []) {
      if (!isAbsolute(root) || !statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
        throw new ToolError(
          "invalid_input",
          `Write root must be an existing absolute directory: ${root}`,
        );
      }
    }
    const permissions: ToolAction["permissions"] =
      request?.mode === "require_escalated"
        ? { host: true }
        : request?.mode === "with_additional_permissions"
          ? {
              ...(request.write_roots ? { writeRoots: request.write_roots } : {}),
              ...(request.network ? { network: request.network } : {}),
            }
          : undefined;
    return {
      tool,
      arguments: args,
      command: args.command as string,
      shell: "sh",
      cwd,
      paths: [],
      environment: {
        PATH: process.env.PATH ?? "",
        ...(config.temporaryRoots[0] ? { TMPDIR: config.temporaryRoots[0] } : {}),
        ...(config.executionPolicy?.mode === "sandbox"
          ? {
              HOME: config.executionPolicy.homeRoot,
              CLARVIS_HOME: config.executionPolicy.globalRoot,
            }
          : {}),
      },
      ...(permissions ? { permissions } : {}),
      reason: typeof args.justification === "string" ? args.justification : "command execution",
    };
  }
  if (tool === "shell_session")
    return { tool, arguments: args, paths: [], reason: "owned session control" };
  const targets =
    tool === "apply_patch"
      ? patchTargets(args.patch as string, config)
      : typeof args.path === "string"
        ? [resolveFileToolPath(args.path, config)]
        : [];
  const paths = targets.flatMap((path) => {
    const lexical = canonicalTarget(resolve(path)) ?? path;
    try {
      const linked = realpathSync(path);
      return linked === lexical ? [lexical] : [lexical, linked];
    } catch {
      return [lexical];
    }
  });
  const writes = new Set(["write_file", "edit_file", "apply_patch", "remove"]);
  const outside = writes.has(tool)
    ? paths.flatMap((path) => {
        const metadata = config.executionPolicy?.readOnlyPaths.find((root) => within(path, root));
        if (metadata) {
          return statSync(metadata, { throwIfNoEntry: false })?.isDirectory()
            ? [metadata]
            : [metadata, existingWriteRoot(path)];
        }
        const workspace = within(path, config.workspaceRoot);
        if (workspace) {
          return config.executionPolicy?.workspaceAccess === "read-only"
            ? [config.workspaceRoot]
            : [];
        }
        if (config.executionPolicy && within(path, config.executionPolicy.homeRoot)) {
          return [existingWriteRoot(path)];
        }
        return config.temporaryRoots.some((root) => within(path, root))
          ? []
          : [existingWriteRoot(path)];
      })
    : [];
  return {
    tool,
    arguments: args,
    paths,
    ...(outside.length ? { permissions: { writeRoots: outside } } : {}),
    reason: outside.length ? "write outside permitted roots" : "ordinary tool operation",
  };
}
