import { createRequire } from "node:module";
import type { ErrorObject, Options, ValidateFunction } from "ajv";

/**
 * The narrow slice of Ajv's surface this module exposes: compiling a JSON Schema
 * into a validator and rendering an error list as text.
 *
 * @remarks Kept minimal so callers depend only on what the loop uses, and so the
 *   CommonJS `ajv` module can be typed without importing its class directly.
 */
export interface AjvInstance {
  compile(schema: Record<string, unknown>): ValidateFunction;
  errorsText(
    errors?: ErrorObject[] | null,
    opts?: { dataVar?: string; separator?: string },
  ): string;
}

interface AjvModules {
  Ajv: new (opts?: Options) => AjvInstance;
  addFormats: (ajv: AjvInstance) => unknown;
}

let modules: AjvModules | undefined;

/**
 * Load `ajv` and `ajv-formats` on first use, once.
 *
 * @remarks These used to be required at module scope, which charged every host
 *   that merely *reaches* this module — the terminal UI reaches it through
 *   delegation, on the boot path — for loading a validator and compiling its
 *   format vocabulary, whether or not a single tool call was ever validated.
 *   Nothing else about the module changes: both public factories already built
 *   their instance inside a function.
 *
 * @returns the two loaded modules.
 */
function load(): AjvModules {
  if (modules === undefined) {
    const require = createRequire(import.meta.url);
    modules = {
      Ajv: require("ajv") as new (opts?: Options) => AjvInstance,
      addFormats: require("ajv-formats") as (ajv: AjvInstance) => unknown,
    };
  }
  return modules;
}

/**
 * Construct an Ajv instance with the given options and the `ajv-formats`
 * format vocabulary (e.g. `date-time`, `email`) registered.
 *
 * @param opts - Ajv constructor options.
 * @returns the configured {@link AjvInstance}.
 */
function build(opts: Options): AjvInstance {
  const { Ajv, addFormats } = load();
  const ajv = new Ajv(opts);
  addFormats(ajv);
  return ajv;
}

/**
 * An Ajv instance for validating data against caller-supplied schemas.
 *
 * @returns an {@link AjvInstance} that collects all errors (`allErrors`) and is
 *   lenient about the schema itself (`strict: false`) — suited to arbitrary
 *   `output_schema` values whose authorship the loop does not control.
 */
export function createAjv(): AjvInstance {
  return build({ strict: false, allErrors: true });
}

/**
 * Like {@link createAjv} but with `strictSchema` on, so a malformed or
 * unrecognized schema construct is reported when the schema is compiled.
 *
 * @returns an {@link AjvInstance} used to vet a schema's well-formedness (e.g.
 *   rejecting a bad `output_schema` before a run starts).
 */
export function createStrictAjv(): AjvInstance {
  return build({ strict: false, allErrors: true, strictSchema: true });
}
