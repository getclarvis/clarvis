import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import { relative, join } from "node:path";
import { CacheBudget } from "./limits.ts";
import { createCacheRecorder } from "./recorder.ts";
import { cacheHash } from "./wire.ts";
import type { CacheCall, CacheLimits } from "./types.ts";

/** Observation only: hash and load the exact installed JavaScript bytes, then tee production HTTP. */
const configPath = process.env.CLARVIS_CACHE_ARTIFACT_OBSERVER;
if (configPath) {
  const config = JSON.parse(readFileSync(configPath, "utf8")) as {
    bundleDirectory: string;
    evidence: string;
    model: string;
    trial: number;
    sdkVersion: string;
    limits: CacheLimits;
    globalLimits?: CacheLimits;
    globalCalls?: CacheCall[];
    globalStartedAt?: number;
    sessionsDirectory?: string;
    workspaceKey?: string;
    leaderId?: string;
  };
  const append = (value: unknown) =>
    appendFileSync(
      config.evidence,
      JSON.stringify({ pid: process.pid, ...(value as object) }) + "\n",
      { mode: 0o600 },
    );
  Bun.plugin({
    name: "clarvis-cache-artifact-observer",
    setup(build) {
      const escaped = config.bundleDirectory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      build.onLoad({ filter: new RegExp(`^${escaped}.*\\.js$`) }, (args) => {
        const bytes = readFileSync(args.path);
        append({
          type: "loaded_bundle",
          path: relative(config.bundleDirectory, args.path),
          hash: cacheHash(bytes),
        });
        return { contents: bytes, loader: "js" };
      });
    },
  });
  let leader = config.leaderId;
  const readLeader = (directory: string): string | undefined => {
    try {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          const found = readLeader(path);
          if (found) return found;
        } else if (entry.name.endsWith(".json") && !entry.name.endsWith(".summary.json")) {
          const session = JSON.parse(readFileSync(path, "utf8"));
          if (
            session.workspace === config.workspaceKey &&
            typeof session.agent_instance_id === "string"
          )
            return session.agent_instance_id;
        }
      }
    } catch {}
    return undefined;
  };
  const recorder = createCacheRecorder(globalThis.fetch, {
    scenario: "C11",
    trial: config.trial,
    sdkVersion: config.sdkVersion,
    requestedModel: config.model,
    effort: "medium",
    leaderId: "unassigned",
    budget: new CacheBudget(config.limits),
    globalBudget: new CacheBudget(
      config.globalLimits ?? config.limits,
      config.globalCalls,
      config.globalStartedAt,
    ),
    phase: () => "growth",
    base: () => 0,
    purpose: ({ agentInstanceId }) => {
      leader ??= config.sessionsDirectory ? readLeader(config.sessionsDirectory) : undefined;
      return !leader ? "auxiliary" : agentInstanceId === leader ? "leader" : "memory";
    },
    completed: (call) => append({ type: "physical_call", call }),
  });
  globalThis.fetch = recorder.fetch;
}
