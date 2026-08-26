import type { ValidateFunction } from "ajv";
import type { NamespacedTool } from "@clarvis/capability";
import { ValidationError } from "@clarvis/capability";
import { createStrictAjv } from "../../validation/ajv.ts";
import { buildSubmitResultTool } from "./submit-result-tool.ts";

/**
 * The verdict of validating `submit_result` arguments against the output schema:
 * `ok` with the accepted `value`, or `!ok` with a human-readable `error`.
 */
export interface ResultValidation {
  ok: boolean;
  value?: unknown;
  error?: string;
}

/**
 * A compiled output-schema contract: the `submit_result` {@link NamespacedTool}
 * to advertise, paired with a `validate` that checks a submitted object against
 * that schema.
 */
export interface ResultContract {
  tool: NamespacedTool;
  validate(args: unknown): ResultValidation;
}

/** Structural ceilings applied before AJV can recursively compile caller data. */
export const OUTPUT_SCHEMA_LIMITS = Object.freeze({
  nodes: 20_000,
  depth: 64,
  containerEntries: 4_096,
  keyChars: 1_024,
  stringChars: 1_048_576,
  singleStringChars: 262_144,
});

/**
 * Inspect a would-be JSON Schema iteratively, without stringifying or invoking
 * accessors. AJV necessarily walks and generates code from this graph, so the
 * request body byte limit alone is not enough: a tiny deeply nested or sparse
 * value can amplify into a much larger compiler working set.
 */
function outputSchemaBudgetIssue(root: object): string | null {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  const seen = new WeakSet<object>();
  let nodes = 0;
  let stringChars = 0;

  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > OUTPUT_SCHEMA_LIMITS.nodes) {
      return `contains more than ${String(OUTPUT_SCHEMA_LIMITS.nodes)} values`;
    }

    const value = current.value;
    if (typeof value === "string") {
      if (value.length > OUTPUT_SCHEMA_LIMITS.singleStringChars) {
        return `contains a string longer than ${String(OUTPUT_SCHEMA_LIMITS.singleStringChars)} characters`;
      }
      stringChars += value.length;
      if (stringChars > OUTPUT_SCHEMA_LIMITS.stringChars) {
        return `contains more than ${String(OUTPUT_SCHEMA_LIMITS.stringChars)} string characters`;
      }
      continue;
    }
    if (value === null || typeof value === "boolean" || typeof value === "number") continue;
    if (typeof value !== "object") return "must contain only JSON values";
    if (current.depth > OUTPUT_SCHEMA_LIMITS.depth) {
      return `is nested deeper than ${String(OUTPUT_SCHEMA_LIMITS.depth)} levels`;
    }
    if (seen.has(value)) return "must be an acyclic JSON tree";
    seen.add(value);

    if (Array.isArray(value) && value.length > OUTPUT_SCHEMA_LIMITS.containerEntries) {
      return `contains an array longer than ${String(OUTPUT_SCHEMA_LIMITS.containerEntries)} items`;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors).filter(
      (key) => !(Array.isArray(value) && key === "length"),
    );
    if (keys.length > OUTPUT_SCHEMA_LIMITS.containerEntries) {
      return `contains an object with more than ${String(OUTPUT_SCHEMA_LIMITS.containerEntries)} fields`;
    }
    for (const key of keys) {
      if (key.length > OUTPUT_SCHEMA_LIMITS.keyChars) {
        return `contains a field name longer than ${String(OUTPUT_SCHEMA_LIMITS.keyChars)} characters`;
      }
      stringChars += key.length;
      if (stringChars > OUTPUT_SCHEMA_LIMITS.stringChars) {
        return `contains more than ${String(OUTPUT_SCHEMA_LIMITS.stringChars)} string characters`;
      }
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor)) {
        return "must not contain accessors";
      }
      pending.push({ value: descriptor.value, depth: current.depth + 1 });
    }
  }
  return null;
}

/**
 * Compile a run's `output_schema` into a {@link ResultContract}, building the
 * matching `submit_result` tool and a strict validator for its arguments.
 *
 * @param outputSchema - the caller-supplied JSON Schema the final result must
 *   satisfy.
 * @returns the tool descriptor plus a `validate` yielding {@link ResultValidation}.
 * @throws {@link ValidationError} with code `invalid_output_schema` when the schema
 *   is not an object, is not well-formed, declares `$async`, or does not describe
 *   an object at its top level.
 */
export function compileResultContract(outputSchema: unknown): ResultContract {
  if (typeof outputSchema !== "object" || outputSchema === null || Array.isArray(outputSchema)) {
    throw new ValidationError(
      "invalid_output_schema",
      "output_schema must be a JSON Schema object.",
    );
  }

  let validateFn: ValidateFunction;
  let ajv: ReturnType<typeof createStrictAjv>;
  try {
    const budgetIssue = outputSchemaBudgetIssue(outputSchema);
    if (budgetIssue !== null) {
      throw new Error(`output_schema ${budgetIssue}`);
    }
    ajv = createStrictAjv();
    validateFn = ajv.compile(outputSchema as Record<string, unknown>);
  } catch (err) {
    throw new ValidationError(
      "invalid_output_schema",
      `output_schema is not a well-formed JSON Schema: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if ((validateFn as { $async?: unknown }).$async) {
    throw new ValidationError(
      "invalid_output_schema",
      'output_schema must be synchronous; the "$async" keyword is not supported.',
    );
  }

  const topType = (outputSchema as { type?: unknown }).type;
  const describesObject =
    topType === undefined ||
    topType === "object" ||
    (Array.isArray(topType) && topType.includes("object"));
  if (!describesObject) {
    throw new ValidationError(
      "invalid_output_schema",
      'output_schema must describe an object (its top-level "type" must be "object"); ' +
        "submit_result arguments are always a JSON object.",
    );
  }

  const tool = buildSubmitResultTool(outputSchema as Record<string, unknown>);

  return {
    tool,
    validate(args: unknown): ResultValidation {
      const ok = validateFn(args);
      if (ok) return { ok: true, value: args };
      return {
        ok: false,
        error: `submit_result rejected: ${ajv.errorsText(validateFn.errors, { dataVar: "result" })}`,
      };
    },
  };
}
