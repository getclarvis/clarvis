import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  InvalidPlanError,
  MAX_PLAN_DOCUMENT_BYTES,
  planDocumentSchema,
  type PlanDocument,
} from "@clarvis/plan";

/**
 * Preserve canonical YAML aliases in extension metadata instead of expanding shared graphs into
 * arbitrarily larger JSON. The remaining document fields have the canonical bounded text shapes.
 */
export function encodePlanWireDocument(document: PlanDocument): unknown {
  return {
    ...document,
    unknown_frontmatter: stringifyYaml(document.unknown_frontmatter, { lineWidth: 0 }),
  };
}

/** Decode the private metadata representation and validate the canonical document before use. */
export function decodePlanWireDocument(value: unknown): PlanDocument {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidPlanError("runtime returned an invalid plan document");
  }
  const document = value as Record<string, unknown>;
  let decoded = document;
  if (typeof document.unknown_frontmatter === "string") {
    if (Buffer.byteLength(document.unknown_frontmatter) > MAX_PLAN_DOCUMENT_BYTES) {
      throw new InvalidPlanError("runtime plan metadata exceeds the canonical document bound");
    }
    try {
      decoded = { ...document, unknown_frontmatter: parseYaml(document.unknown_frontmatter) };
    } catch {
      throw new InvalidPlanError("runtime plan metadata is invalid YAML");
    }
  }
  const parsed = planDocumentSchema.safeParse(decoded);
  if (!parsed.success)
    throw new InvalidPlanError(`runtime returned an invalid plan: ${parsed.error.message}`);
  return parsed.data;
}

/** Check replacement documents at the host authority boundary, including encoded metadata. */
export function validPlanWireDocument(value: unknown): boolean {
  try {
    decodePlanWireDocument(value);
    return true;
  } catch {
    return false;
  }
}
