import type {
  ActiveTaskRequestDto,
  Message,
  PlansMode,
  RunCompactionResult,
  RunResult,
  StartHostedTurnParams,
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
  /** Host-owned turn admission; required when the backend advertises hosted execution. */
  session?: Omit<StartHostedTurnParams, "params">;
  messages?: Message[];
  profile?: string;
  executionId?: string;
  /** Volatile authorization identity, replaced whenever a session is opened or resumed. */
  configurationSessionId?: string;
  continueFrom?: string;
  sessionId?: string;
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
  /** Release this hosted observation; the host separately applies the conversation's exit policy. */
  releaseObservation?(): Promise<void>;
  /** Explicitly acquire this existing observation's controller without replaying its transcript. */
  acquireControl?(control: "acquire" | "takeover"): Promise<void>;
  done: Promise<RunResult | undefined>;
  /**
   * Resolves after stream delivery and closure. A hosted disconnect rejects: losing its
   * observation does not prove that the independently owned execution physically ended.
   */
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
