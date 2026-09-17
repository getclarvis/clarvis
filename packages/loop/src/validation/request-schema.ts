import type {
  CapabilityRegistry,
  EnvConfig,
  RunRequest,
  ModelExecutionResolver,
} from "@clarvis/capability";
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
import { createCapabilityRequestView } from "@clarvis/capability";
import { BUILTIN_SETTINGS_SPECS } from "../runtime/capabilities/settings-specs.ts";

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
  options: { modelExecutionResolver?: ModelExecutionResolver } = {},
): ValidatedRunRequest {
  const data = parseRunRequest(raw, registry, options.modelExecutionResolver !== undefined);
  rejectDuplicateServerNames(data);
  rejectDuplicateProfileNames(data);
  requireKnownGrants(data, registry);
  const shape = requireEntryShape(data);
  requireKnownSpawnTargets(data, shape);
  enforceBudgetMode(data, shape);
  enforceEnvCeilings(data, env);
  const view = createCapabilityRequestView(data);
  const referencedModels = [...BUILTIN_SETTINGS_SPECS, ...(registry?.specs() ?? [])].flatMap(
    (spec) => spec.referencedModels?.(view) ?? [],
  );
  rejectProviderConfigIssues(data, options.modelExecutionResolver, referencedModels);
  requireResolvableModelProviders(data, options.modelExecutionResolver, referencedModels);
  enforcePerProfileRules(data, env, options.modelExecutionResolver);
  return { request: data, shape };
}
