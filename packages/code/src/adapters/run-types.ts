import type {
  ActiveTaskRequestDto,
  Message,
  PlansMode,
  RunCompactionResult,
  RunResult,
} from "@clarvis/protocol";
import type { GuardMode } from "./guard-mode.ts";

/**
 * The run-slice vocabulary the UI programs against, independent of any backend.
 * Progress/notice shapes live in core so presenters stay adapter-free; the rest
 * of the start/steer surface stays here with adapter peers.
 */

export type { MemoryIngestNotice, RunProgress } from "../core/run-types.ts";

/** An agent profile as summarized for the UI's profile pickers and info panels. */
export interface ProfileInfo {
  name: string;
  description?: string;
  model?: string;
  canSpawn?: string[];
  budget?: { on_exceed?: string; total_token_limit?: number };
  /** Tool grants from the agent frontmatter (kernel-projected). Undefined when
   * the frontmatter could not be parsed — rendered as "unknown". */
  grants?: string[];
}

interface GuardJudgeInput {
  prompt: string;
  model?: string;
  onUnsure?: "ask" | "deny";
  timeoutMs?: number;
}

/** Parameters accepted by the adapter's `startRun` entry point. */
export interface StartRunInput {
  messages?: Message[];
  profile?: string;
  executionId?: string;
  continueFrom?: string;
  promptCacheKey?: string;
  guardMode?: GuardMode;
  guardJudge?: GuardJudgeInput;
  memory?: "on" | "off";
  plans?: PlansMode;
  /** Optional external task bound to this run; the current workspace stays implicit. */
  task?: ActiveTaskRequestDto;
  skill?: { name: string; task?: string };
}

/** A handle to an in-flight run: its result and the later end of its event-stream lifecycle. */
export interface RunHandle {
  executionId: string;
  cancel(): Promise<void>;
  done: Promise<RunResult | undefined>;
  /** Resolves after the protocol stream and the client's event pump have both released the run. */
  closed: Promise<void>;
  /** Current protocol queue counters when the active transport exposes them. */
  buffered?: () => { buffered_items: number; buffered_bytes: number; dropped: number } | undefined;
}

/** The outcome of steering a run mid-flight. */
export interface SteerResult {
  status: string;
  execution_id?: string;
  accepted?: number;
  error?: string;
}

/** Immediate or settled outcome for an explicit compaction request. */
export type CompactResult = RunCompactionResult;
