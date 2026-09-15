/** Versioned evidence vocabulary shared by execution, evaluation and artifact qualification. */
export const CACHE_REPORT_VERSION = 1 as const;
export type CacheScenario =
  "C01" | "C02" | "C03" | "C04" | "C05" | "C06" | "C07" | "C08" | "C09" | "C10" | "C11";
export type CachePurpose = "leader" | "child" | "memory" | "compaction" | "auxiliary";
export type CacheVerdict = "pass" | "fail" | "incomplete";

export interface CacheUsage {
  input: number;
  cached: number;
  output: number;
}

/** One actual HTTP attempt, including failed, cancelled and auxiliary calls. */
export interface CacheCall<Scenario extends string = CacheScenario> {
  scenario: Scenario;
  trial: number;
  sessionId: string;
  agentInstanceId: string;
  executionId?: string;
  iteration: number;
  attempt: number;
  purpose: CachePurpose;
  phase: string;
  base: number;
  startedAt: number;
  endedAt: number;
  requestedModel: string;
  serializedModel?: string;
  resolvedModel?: string;
  endpoint: string;
  requestedEffort?: string;
  serializedEffort?: string;
  effectiveEffort?: string;
  sdkVersion: string;
  keyHash: string;
  sessionHeaderHash?: string;
  instructionsHash: string;
  toolsHash: string;
  parametersHash: string;
  itemHashes: string[];
  itemMetadata?: Array<{
    index: number;
    type?: string;
    id?: string;
    callId?: string;
    phase?: string;
    reasoningParts?: number;
    encrypted?: boolean;
  }>;
  /** First structural divergence in previously serialized history; never a token-cache boundary. */
  divergence?: {
    surface: "instructions" | "tools" | "identity" | "history";
    item?: number;
    path?: string;
  };
  compaction?: boolean;
  transition?: string;
  usage?: CacheUsage;
  status: "completed" | "failed" | "cancelled";
  toolCalls: Array<{ name: string; callId: string; itemId?: string }>;
  diagnostic?: string;
  responseContentType?: string;
  truncatedNewResult?: boolean;
}

export interface CacheLimits {
  calls: number;
  input: number;
  output: number;
  durationMs: number;
}

export interface CacheWindowEvaluation {
  name: string;
  verdict: CacheVerdict;
  reasons: string[];
  calls: number;
  weightedHit?: number;
  lastHits: number[];
  inputGrowth?: number;
  cachedGrowth?: number;
}

export interface CacheAgentEvaluation {
  sessionId: string;
  agentInstanceId: string;
  purpose: CachePurpose;
  verdict: CacheVerdict;
  reasons: string[];
  windows: CacheWindowEvaluation[];
  totals: CacheUsage;
  unknownUsageCalls: number;
  physicalCalls: number;
}

export interface CacheTrial {
  scenario: CacheScenario;
  trial: number;
  model: string;
  limits: CacheLimits;
  checkpoints: Array<{ name: string; verdict: CacheVerdict; evidence?: string }>;
  calls: CacheCall[];
  agents: CacheAgentEvaluation[];
  verdict: CacheVerdict;
  diagnostics: string[];
  artifactHash?: string;
  loadedBundleHash?: string;
  accounting?: Array<{
    executionId: string;
    usage: CacheUsage;
    physicalCalls: number;
    unknownUsageCalls: number;
    reconciled: boolean;
  }>;
}

export interface CacheReport {
  schemaVersion: typeof CACHE_REPORT_VERSION;
  source: {
    commit: string;
    inputsHash: string;
    lockfileHash: string;
    bun: string;
    platform: string;
    arch: string;
    sdkVersion: string;
    fixtureHash: string;
    configHash: string;
  };
  artifact?: {
    archiveHash: string;
    bundleHash: string;
    loadedBundleHash: string;
    launcher: string;
  };
  limits: CacheLimits;
  expected: Array<{ scenario: CacheScenario; model: string; trials: number }>;
  trials: CacheTrial[];
  verdict: CacheVerdict;
  diagnostics: string[];
}
