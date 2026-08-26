import { PLAN_REVIEW_ELICIT_KIND } from "./elicit-types.ts";
import type { ElicitCommandDetail, ElicitRequestParams, ElicitResult } from "./elicit-types.ts";

/** A single elicitation field's answer, coerced to the type its `kind` implies. */
export type ElicitContentValue = string | number | boolean | string[];

interface ElicitOption {
  value: string;
  label: string;
}

type ElicitFieldKind = "select" | "text" | "number" | "boolean";

/** One input field of a parsed elicitation form, derived from its JSON-schema property. */
export interface ElicitField {
  name: string;
  title: string;
  description?: string;
  required: boolean;
  kind: ElicitFieldKind;
  options: ElicitOption[];
  default?: string;
}

export interface ElicitForm {
  mode: "form" | "url";
  message: string;
  fields: ElicitField[];
  url?: string;
  /** Structured guard command context; when present the view renders it
   * instead of `message`. */
  detail?: ElicitCommandDetail;
}

type PrimitiveSchema = {
  type?: string;
  title?: string;
  description?: string;
  enum?: unknown;
  oneOf?: unknown;
  default?: unknown;
};

function optionsFromSchema(schema: PrimitiveSchema): ElicitOption[] {
  if (Array.isArray(schema.enum)) {
    return schema.enum
      .filter((v): v is string => typeof v === "string")
      .map((v) => ({ value: v, label: v }));
  }
  if (Array.isArray(schema.oneOf)) {
    return schema.oneOf
      .filter(
        (o): o is { const: string; title?: string } =>
          typeof (o as { const?: unknown }).const === "string",
      )
      .map((o) => ({ value: o.const, label: o.title ?? o.const }));
  }
  return [];
}

function fieldFromSchema(name: string, schema: PrimitiveSchema, required: boolean): ElicitField {
  const options = optionsFromSchema(schema);
  let kind: ElicitFieldKind;
  if (options.length > 0) kind = "select";
  else if (schema.type === "boolean") kind = "boolean";
  else if (schema.type === "number" || schema.type === "integer") kind = "number";
  else kind = "text";
  const def = schema.default;
  return {
    name,
    title: schema.title ?? name,
    description: schema.description,
    required,
    kind,
    options:
      kind === "boolean" && options.length === 0
        ? [
            { value: "true", label: "yes" },
            { value: "false", label: "no" },
          ]
        : options,
    default: def === undefined ? undefined : String(def),
  };
}

const GUARD_DECISION_LABELS: Record<string, string> = {
  deny: "deny",
  allow: "allow once",
  allow_session: "allow for this session",
};

/** The plan-review verdicts in the user's words rather than the wire's. */
const PLAN_DECISION_LABELS: Record<string, string> = {
  approve: "approve",
  request_changes: "request changes",
  cancel: "cancel run",
};

const WORKFLOW_DECISION_LABELS: Record<string, string> = {
  run: "run workflow",
  cancel: "do not run",
};

const DECISION_LABELS: Record<string, Record<string, string>> = {
  guard_confirm: GUARD_DECISION_LABELS,
  [PLAN_REVIEW_ELICIT_KIND]: PLAN_DECISION_LABELS,
  workflow_review: WORKFLOW_DECISION_LABELS,
};

/**
 * Parses raw {@link ElicitRequestParams} into a renderable {@link ElicitForm}.
 *
 * @remarks
 * Chooses the `url` variant when `mode` says so, or when a `url` is present
 * with no `requestedSchema`; otherwise renders the schema's properties as
 * fields. When `kind` names a known decision vocabulary
 * (`guard_confirm`/`plan_review`), option labels are relabeled into the
 * user-facing wording from {@link DECISION_LABELS} instead of the raw wire
 * values.
 */
export function parseElicitForm(params: ElicitRequestParams): ElicitForm {
  const p = params as {
    message?: string;
    url?: string;
    mode?: string;
    requestedSchema?: { properties?: Record<string, PrimitiveSchema>; required?: string[] };
  };
  const message = p.message ?? "";
  if (p.mode === "url" || (typeof p.url === "string" && p.requestedSchema === undefined)) {
    return { mode: "url", message, fields: [], url: p.url };
  }
  const properties = p.requestedSchema?.properties ?? {};
  const required = new Set(p.requestedSchema?.required ?? []);
  const fields = Object.keys(properties).map((name) =>
    fieldFromSchema(name, properties[name] ?? {}, required.has(name)),
  );
  const labels = params.kind === undefined ? undefined : DECISION_LABELS[params.kind];
  if (labels) {
    for (const field of fields)
      for (const option of field.options) option.label = labels[option.value] ?? option.label;
  }
  const detail =
    params.detail !== undefined && params.detail.command.trim().length > 0
      ? params.detail
      : undefined;
  return { mode: "form", message, fields, ...(detail !== undefined ? { detail } : {}) };
}

/** How an un-defaulted choice field starts. */
export type ChoiceInitialSelection = "first" | "none";

/**
 * Seeds each field's initial string value.
 *
 * @remarks Most questions select their first choice so an ordinary boolean or
 * lightweight question remains answerable. An approval gate can instead leave
 * choices empty: selecting and confirming are then two separate deliberate
 * actions, and required-field validation prevents an accidental Enter from
 * becoming an approval.
 */
export function initialValues(
  fields: ElicitField[],
  choiceInitialSelection: ChoiceInitialSelection = "first",
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const f of fields) {
    if ((f.kind === "select" || f.kind === "boolean") && choiceInitialSelection === "none")
      values[f.name] = "";
    else if (f.default !== undefined) values[f.name] = f.default;
    else if ((f.kind === "select" || f.kind === "boolean") && f.options.length > 0)
      values[f.name] = f.options[0]!.value;
    else values[f.name] = "";
  }
  return values;
}

/**
 * Names of required fields that are blank or, for a `number` field, non-numeric.
 */
export function missingRequired(fields: ElicitField[], values: Record<string, string>): string[] {
  return fields
    .filter((f) => {
      if (!f.required) return false;
      const raw = (values[f.name] ?? "").trim();
      if (raw.length === 0) return true;
      return f.kind === "number" && Number.isNaN(Number(raw));
    })
    .map((f) => f.name);
}

/**
 * Coerces raw form `values` into the typed content object an elicitation
 * response carries.
 *
 * @remarks Blank values are omitted entirely rather than sent as empty
 *   strings, and a non-numeric `number` field is likewise dropped instead of
 *   sent as `NaN`.
 */
export function buildContent(
  fields: ElicitField[],
  values: Record<string, string>,
): Record<string, ElicitContentValue> {
  const content: Record<string, ElicitContentValue> = {};
  for (const f of fields) {
    const raw = (values[f.name] ?? "").trim();
    if (raw.length === 0) continue;
    if (f.kind === "number") {
      const n = Number(raw);
      if (!Number.isNaN(n)) content[f.name] = n;
    } else if (f.kind === "boolean") {
      content[f.name] = raw === "true";
    } else {
      content[f.name] = raw;
    }
  }
  return content;
}

/** Builds the `accept` {@link ElicitResult} from a form's fields and values. */
export function acceptResult(fields: ElicitField[], values: Record<string, string>): ElicitResult {
  return { action: "accept", content: buildContent(fields, values) };
}

/** The shared `decline` result, for elicitations the user dismisses without answering. */
export const DECLINE_RESULT: ElicitResult = { action: "decline" };
/** The shared `cancel` result, for elicitations superseded or abandoned before an answer. */
export const CANCEL_RESULT: ElicitResult = { action: "cancel" };
