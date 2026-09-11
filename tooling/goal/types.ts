import type { GoalRecord, RunDetail } from "@clarvis/protocol";
import type { CachePurpose } from "../cache/types.ts";
import type { GoalPhysicalCall } from "./fixture.ts";

/** Credential-free job crossing the dedicated native host worker process boundary. */
export interface GoalLiveJob {
  root: string;
  globalDir: string;
  model: string;
  trial: number;
  outputFile: string;
  sdkVersion: string;
  globalCalls: GoalPhysicalCall[];
  globalStartedAt: number;
}

/** Per-trial evidence; a passing process alone cannot satisfy these checkpoints. */
export interface GoalLiveResult {
  schema_version: 2;
  model: string;
  trial: number;
  started_at: number;
  ended_at?: number;
  runtime: "native";
  verdict: "pass" | "fail" | "incomplete";
  diagnostics: string[];
  calls: GoalPhysicalCall[];
  tool_events: Array<{
    execution_id: string;
    call_id?: string;
    tool: string;
    ok: boolean;
    action?: "progress" | "checkpoint" | "candidate" | "blocked";
    argument_shape: unknown;
    error?: string;
  }>;
  goal?: GoalRecord;
  stages: Array<
    Pick<RunDetail, "execution_id" | "status" | "continue_from" | "plan_ref" | "result">
  >;
  checkpoints: Record<string, boolean>;
  agents: Array<{
    id: string;
    purpose: CachePurpose;
    calls: number;
    input: number;
    output: number;
    cached: number;
    unknown: number;
    weighted_hit?: number;
  }>;
  cleanup?: boolean;
}
