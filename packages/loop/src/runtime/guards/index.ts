/**
 * Barrel for the convergence guards: the combined guard
 * ({@link ./convergence-guards.js}) and its two members — the doom-loop guard
 * for tool failures ({@link ./doom-loop-guard.js}) and the stagnation guard for
 * identical results ({@link ./stagnation-guard.js}) — plus the opt-in
 * escalation that lets a human wave a hard trip through
 * ({@link ./guard-escalation.js}).
 */
export * from "./convergence-guards.ts";
export * from "./doom-loop-guard.ts";
export * from "./guard-escalation.ts";
export * from "./stagnation-guard.ts";
