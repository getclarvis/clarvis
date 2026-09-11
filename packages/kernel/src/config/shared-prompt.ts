import {
  DEFAULT_SHARED_AGENT_PROMPT,
  resolveSharedPrompt,
  type ResolvedSharedPrompt,
  type SharedPromptLayer,
} from "@clarvis/loop/host";
import type { ConfigStore, SettingsSnapshot, SharedPromptFile } from "./config-store.ts";

/**
 * Whether the workspace layer may contribute executable prompt text.
 *
 * @remarks Memory stores have no trust verdict and are treated as trusted so
 * tests and ephemeral kernels still apply a workspace override they seeded.
 */
function workspaceSharedPromptTrusted(snapshot: SettingsSnapshot): boolean {
  const state = snapshot.workspace_trust?.state;
  return state === undefined || state === "inert" || state === "trusted";
}

function toLayer(file: SharedPromptFile | null, trusted = true): SharedPromptLayer | undefined {
  if (file === null) return undefined;
  return {
    path: file.path,
    ...(file.raw !== undefined ? { raw: file.raw } : {}),
    ...(file.unreadable === true ? { unreadable: true } : {}),
    ...(file.oversized === true ? { oversized: true } : {}),
    trusted,
  };
}

/**
 * Resolve the shared prompt this store would inject into a new run.
 *
 * @param store - settings (for the trust verdict) and the two prompt files.
 */
export function resolveStoreSharedPrompt(
  store: Pick<ConfigStore, "readSettings" | "readSharedPrompt">,
): ResolvedSharedPrompt {
  const snapshot = store.readSettings();
  return resolveSharedPrompt({
    workspace: toLayer(store.readSharedPrompt("workspace"), workspaceSharedPromptTrusted(snapshot)),
    global: toLayer(store.readSharedPrompt("global")),
  });
}

/**
 * The `shared_prompt` field stamped onto an assembled run request.
 *
 * @returns the winning text, or `""` when the shared layer is disabled.
 * @remarks Always materializes a string so children and continuations of this
 * run reuse the snapshot instead of re-reading files. The engine treats `""`
 * as disabled and any other omitted field as the built-in default.
 */
export function stampedSharedPrompt(resolved: ResolvedSharedPrompt): string {
  if (resolved.source === "disabled") return "";
  return resolved.prompt ?? DEFAULT_SHARED_AGENT_PROMPT;
}

/** Paths the UI shows for the two editable scopes. */
export function sharedPromptPaths(store: Pick<ConfigStore, "readSharedPrompt">): {
  global: string;
  workspace?: string;
} {
  const global = store.readSharedPrompt("global");
  const workspace = store.readSharedPrompt("workspace");
  return {
    global: global?.path ?? "shared-agent.md",
    ...(workspace !== null ? { workspace: workspace.path } : {}),
  };
}

export type { ResolvedSharedPrompt, SharedPromptLayer };
