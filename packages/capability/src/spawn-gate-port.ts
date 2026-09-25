import type { AgentBuildContext } from "./loop-contract.ts";
import type { AgentResult } from "./agent-result.ts";
import { portKey } from "./services.ts";

/** An optional capability's ruling before an independent child starts. */
export type SpawnGate =
  { kind: "ok" } | { kind: "refuse"; text: string } | { kind: "terminal"; result: AgentResult };

/** The optional pre-spawn gate consumed by the child-spawn capability. */
export interface SpawnGatePort {
  beforeSpawn(): Promise<SpawnGate>;
}

/** Hands out the gate bound to one agent build context. */
export interface SpawnGateProvider {
  forAgent(bc: AgentBuildContext): SpawnGatePort | undefined;
}

/** Canonical service key for an optional child-spawn gate. */
export const SPAWN_GATE_PORT = portKey<SpawnGateProvider>("delegation.spawn-gate");
