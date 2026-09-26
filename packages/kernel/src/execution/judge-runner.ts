import { mkdtempSync, rmSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createExecutionPolicy, BubblewrapBackend, SeatbeltBackend } from "@clarvis/sandbox";
import { globalPaths } from "@clarvis/paths";
import {
  SandboxToolExecutor,
  createAgentTools,
  dispatch,
  sandboxWorkerRoot,
  tools,
} from "@clarvis/tools";
import type { ReviewRunner } from "@clarvis/judge";

const INSPECTION_TOOLS = new Set(["read_file", "list_dir", "read_image", "shell"]);

/** A private native sandbox with read-only workspace and no network. */
export function createJudgeRunner(options: {
  workspaceRoot: string;
  globalRoot: string;
  homeRoot?: string;
  productRoot?: string;
  denyReadPaths?: readonly string[];
}): ReviewRunner {
  const scratch = mkdtempSync(join(tmpdir(), "clarvis-judge-"));
  try {
    const policy = createExecutionPolicy({
      id: "judge-inspection",
      mode: "sandbox",
      workspaceRoot: options.workspaceRoot,
      globalRoot: options.globalRoot,
      ...(options.homeRoot ? { homeRoot: options.homeRoot } : {}),
      workspaceAccess: "read-only",
      network: "disabled",
      temporaryWriteRoots: [scratch],
      installationRoots: [
        dirname(realpathSync(process.execPath)),
        ...(existsSync(sandboxWorkerRoot) ? [sandboxWorkerRoot] : []),
        ...(options.productRoot && existsSync(options.productRoot) ? [options.productRoot] : []),
      ],
      denies: [
        ...(options.denyReadPaths ?? []),
        ...[
          globalPaths(options.globalRoot).keysFile,
          globalPaths(options.globalRoot).subscriptionsFile,
          globalPaths(options.globalRoot).mcpOAuthFile,
        ].filter(existsSync),
      ],
    });
    const backend = process.platform === "darwin" ? new SeatbeltBackend() : new BubblewrapBackend();
    const worker = new SandboxToolExecutor(policy, backend, scratch);
    const toolset = createAgentTools({
      workspaceRoot: options.workspaceRoot,
      executionPolicy: policy,
      executionPort: worker,
      sandboxBackend: backend,
      temporaryRoots: [scratch],
      shellTimeoutMs: 10_000,
      shellTimeoutMaxMs: 10_000,
      maxSessions: 1,
      secretEnvNames: Object.keys(process.env).filter(
        (name) => name !== "PATH" && name !== "LANG" && name !== "LC_ALL",
      ),
    });
    let closed = false;
    return {
      tools: tools
        .filter((tool) => INSPECTION_TOOLS.has(tool.name))
        .map((tool) => ({
          fullName: tool.name,
          wireName: tool.name,
          mcpName: "",
          toolName: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      async run(name, args, signal) {
        if (closed || !INSPECTION_TOOLS.has(name)) throw new Error("inspection tool unavailable");
        const safeArgs = name === "shell" ? { ...args, timeout_ms: 10_000 } : args;
        if (name === "shell") {
          delete safeArgs.yield_time_ms;
          delete safeArgs.ready_when;
        }
        const result = await dispatch(name, safeArgs, toolset.config, signal);
        const content = result.content
          .map((part) => (part.type === "text" ? part.text : "[image]"))
          .join("\n");
        if (
          result.isError &&
          /"error":"(?:sandbox_setup_failed|sandbox_unavailable|aborted)"/.test(content)
        )
          throw new Error(`inspection sandbox unavailable: ${content.slice(0, 500)}`);
        return {
          text: content.slice(0, 32_000),
          ...(result.content.some((part) => part.type === "image")
            ? {
                images: result.content
                  .filter((part) => part.type === "image")
                  .map((part) => ({ data: part.data, mediaType: part.mimeType })),
              }
            : {}),
        };
      },
      async close() {
        if (closed) return;
        closed = true;
        try {
          await toolset.close();
        } finally {
          rmSync(scratch, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    rmSync(scratch, { recursive: true, force: true });
    throw error;
  }
}
