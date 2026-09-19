import type { GoalLimits, GoalRepository, GoalRuntimePort } from "@clarvis/goal";
import type { Session } from "@clarvis/protocol";
import type { GoalEvidenceSource } from "./evidence.ts";

export interface GoalCreationPortOptions {
  repository: GoalRepository;
  session: Session;
  executionId: string;
  agentInstanceId: string;
  seed: string;
  evidence: GoalEvidenceSource;
  defaultLimits?: Partial<GoalLimits>;
  entryTokenLimit?: number;
  signal?: AbortSignal;
  now?: () => number;
  onChange?: (sessionId: string) => void;
}

export interface CreationTransactionOptions {
  session: Session;
  executionId: string;
  seed: string;
  defaultLimits?: Partial<GoalLimits>;
  entryTokenLimit?: number;
  now: () => number;
  fingerprint: string;
}

export interface CreationLifecycle {
  readonly runtime?: GoalRuntimePort;
  readonly inFlight?: Promise<GoalRuntimePort>;
}
