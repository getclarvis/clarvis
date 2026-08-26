import { portKey } from "@clarvis/capability";
import type { AgentRegistry } from "./registry.ts";

/**
 * Run-scoped service key for the supervision registry.
 *
 * @remarks The engine publishes this before any capability activates. A
 * producer that only needs registration may consume it as the narrower
 * `AgentRegistryPort`; engine policy retains the full registry surface.
 */
export const AGENT_REGISTRY_PORT = portKey<AgentRegistry>("supervision.agents");
