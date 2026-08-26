import type { CapabilityRegistry, EnvConfig, RunRequest } from "@clarvis/capability";
import { parseRunRequest } from "./request/parsing.ts";
import {
  rejectDuplicateProfileNames,
  rejectDuplicateServerNames,
  requireEntryShape,
  requireKnownSpawnTargets,
} from "./request/identity-rules.ts";
import { enforceBudgetMode, enforceEnvCeilings } from "./request/budget-rules.ts";
import {
  rejectProviderConfigIssues,
  requireResolvableModelProviders,
} from "./request/provider-rules.ts";
import { enforcePerProfileRules } from "./request/profile-rules.ts";
import { requireKnownGrants } from "./request/grant-registry.ts";
import type { RunShape } from "./request/run-shape.ts";

export { serverSchema } from "./request/server-schemas.ts";
export { agentProfileSchema, grantSchema, modelField } from "./request/profile-schemas.ts";
export { providerConfigSchema } from "./request/provider-schemas.ts";
export { budgetSchema, runRequestSchema } from "./request/request-schema.ts";
export type { ParsedRunRequest } from "./request/request-schema.ts";
export { deriveRunShape } from "./request/run-shape.ts";
export type { RunShape } from "./request/run-shape.ts";

/** A fully-validated request paired with its derived run shape, ready for the engine. */
export interface ValidatedRunRequest {
  request: RunRequest;
  shape: RunShape;
}

/** Parse and validate a request in the stable, observable failure order. */
export function validateBody(
  raw: unknown,
  env: EnvConfig,
  registry?: CapabilityRegistry,
): ValidatedRunRequest {
  const data = parseRunRequest(raw, registry);
  rejectDuplicateServerNames(data);
  rejectDuplicateProfileNames(data);
  requireKnownGrants(data, registry);
  const shape = requireEntryShape(data);
  requireKnownSpawnTargets(data, shape);
  enforceBudgetMode(data, shape);
  enforceEnvCeilings(data, env);
  rejectProviderConfigIssues(data);
  requireResolvableModelProviders(data);
  enforcePerProfileRules(data, env);
  return { request: data, shape };
}
