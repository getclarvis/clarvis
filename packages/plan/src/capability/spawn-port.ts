import type { SpawnGatePort } from "@clarvis/capability";
import { SPAWN_GATE_PORT } from "@clarvis/capability";

/** Planning's pre-spawn gate for independent sub-agents. */
export type PlanSpawnPort = SpawnGatePort;

export type { SpawnGate } from "@clarvis/capability";

/** Service key used by planning to gate child spawning. */
export const PLAN_SPAWN_PORT = SPAWN_GATE_PORT;
