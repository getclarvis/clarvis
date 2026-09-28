import { isDeepStrictEqual } from "node:util";
import { WORKFLOW_RESULT_SCHEMAS, type WorkflowResultSchema } from "./schemas.ts";

/** Discard undeclared fields from built-in round results, preserving custom result contracts. */
export function normalizeWorkflowResult(value: unknown, schema?: WorkflowResultSchema): unknown {
  const owned = Object.values(WORKFLOW_RESULT_SCHEMAS).find((candidate) =>
    isDeepStrictEqual(candidate, schema),
  );
  return owned === undefined ? value : project(value, owned);
}

function project(value: unknown, schema: WorkflowResultSchema): unknown {
  if (Array.isArray(value) && schema.items !== undefined)
    return value.map((item) => project(item, schema.items as WorkflowResultSchema));
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  if (schema.properties === undefined) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(schema.properties as Record<string, WorkflowResultSchema>)
      .filter(([key]) => Object.hasOwn(record, key))
      .map(([key, child]) => [key, project(record[key], child)]),
  );
}
