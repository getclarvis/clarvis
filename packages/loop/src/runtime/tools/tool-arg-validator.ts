import type { ValidateFunction } from "ajv";
import { createAjv } from "../../validation/ajv.ts";
import { errorText } from "../../error-text.ts";
import { sanitizeErrorMessage, type Logger } from "@clarvis/capability";

/**
 * Validates a tool call's arguments against its JSON Schema, returning a
 * human-readable error message or `null` when the arguments are acceptable.
 */
export interface ToolArgValidator {
  /**
   * @param schema - the tool's declared JSON Schema, if it has one.
   * @param args - the call's arguments.
   * @param tool - the wire name, for the fail-open diagnostic only.
   * @remarks `tool` is a third *optional* parameter so the bound method still
   *   satisfies `@clarvis/capability`'s two-parameter `ToolArgValidate`, which
   *   the engine hands to every capability's build context. The dispatcher that
   *   knows the name passes it; the contract path cannot, and the diagnostic is
   *   emitted without it rather than not at all.
   */
  validate(
    this: void,
    schema: Record<string, unknown> | undefined,
    args: unknown,
    tool?: string,
  ): string | null;
}

/** Why {@link createToolArgValidator} accepted a call it could not check. */
type FailOpenReason = "async" | "compile_error" | "validator_threw" | "non_boolean";

/**
 * JSON Schema keywords that impose an actual constraint; their presence means a
 * schema is not "empty" even when it declares no `properties`/`required`/`items`.
 */
const CONSTRAINING_KEYWORDS = [
  "oneOf",
  "anyOf",
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "enum",
  "const",
  "$ref",
  "patternProperties",
  "propertyNames",
  "additionalProperties",
  "unevaluatedProperties",
  "dependentRequired",
  "dependentSchemas",
  "dependencies",
  "minProperties",
  "maxProperties",
  "contains",
  "prefixItems",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "format",
];

/**
 * Whether a schema constrains nothing — no properties, required keys, items or
 * {@link CONSTRAINING_KEYWORDS} — so validation can be skipped and any arguments
 * (or none) accepted.
 */
function isEmptySchema(schema: Record<string, unknown>): boolean {
  const keys = Object.keys(schema);
  if (keys.length === 0) return true;
  const props = schema.properties;
  const hasProps = typeof props === "object" && props !== null && Object.keys(props).length > 0;
  const hasRequired = Array.isArray(schema.required) && schema.required.length > 0;
  const hasItems = schema.items !== undefined;
  if (hasProps || hasRequired || hasItems) return false;
  for (const k of CONSTRAINING_KEYWORDS) if (k in schema) return false;
  return true;
}

/**
 * Create a caching, fail-open {@link ToolArgValidator} backed by Ajv.
 *
 * @param logger - optional logger; every fail-open arm reports
 *   `tool.args_validation_failed_open` once per schema.
 * @returns a validator whose `validate` returns an `InputValidationError: …`
 *   message on a genuine schema violation and `null` otherwise.
 * @remarks Fail-open by design: a missing, empty, uncompilable, `$async`, or
 *   otherwise problematic schema — and any thrown error during validation —
 *   yields `null` (accepted) rather than blocking the call. Compiled validators
 *   are cached per schema object in a {@link WeakMap}.
 */
export function createToolArgValidator(logger?: Logger): ToolArgValidator {
  const ajv = createAjv();
  const cache = new WeakMap<object, ValidateFunction | false>();
  /**
   * Schemas whose fail-open has already been reported.
   *
   * @remarks Keyed by the same schema object as {@link cache}, so one broken
   *   tool declaration produces one line however many times the model calls it.
   *   A tool the model calls in a loop is exactly the tool whose schema is
   *   broken, so an unsampled site here would flood the very log an operator
   *   would be reading to find it.
   */
  const reported = new WeakSet<object>();
  /**
   * Report one schema's fail-open, once.
   *
   * @remarks `cause` is rendered through {@link errorText} rather than
   *   `JSON.stringify`, which throws on a circular structure or a BigInt and
   *   answers `undefined` for a symbol or a function. This runs inside a
   *   `catch`, so a reporter that can throw turns a tolerated schema into a
   *   failed tool call.
   */
  const failOpen = (
    schema: Record<string, unknown>,
    reason: FailOpenReason,
    tool: string | undefined,
    cause?: unknown,
  ): null => {
    if (reported.has(schema)) return null;
    reported.add(schema);
    logger?.warn(
      {
        event: "tool.args_validation_failed_open",
        ...(tool !== undefined ? { tool } : {}),
        reason,
        ...(cause === undefined ? {} : { cause: sanitizeErrorMessage(errorText(cause)) }),
      },
      "the tool's arguments could not be validated and the call is accepted unchecked; " +
        "a malformed payload reaches the handler",
    );
    return null;
  };

  return {
    validate(
      this: void,
      schema: Record<string, unknown> | undefined,
      args: unknown,
      tool?: string,
    ): string | null {
      if (schema === undefined || schema === null) return null;
      if (typeof schema !== "object") return null;
      try {
        if (isEmptySchema(schema)) return null;

        let compiled = cache.get(schema);
        if (compiled === undefined) {
          try {
            compiled = ajv.compile(schema);
            if ((compiled as { $async?: unknown }).$async) {
              compiled = false;
              failOpen(schema, "async", tool);
            }
          } catch (err) {
            compiled = false;
            failOpen(schema, "compile_error", tool, err);
          }
          cache.set(schema, compiled);
        }
        if (compiled === false) return null;

        const ok = compiled(args);
        if (ok === true) return null;
        if (ok !== false) return failOpen(schema, "non_boolean", tool);
        return `InputValidationError: ${ajv.errorsText(compiled.errors, { dataVar: "arguments" })}`;
      } catch (err) {
        return failOpen(schema, "validator_threw", tool, err);
      }
    },
  };
}
