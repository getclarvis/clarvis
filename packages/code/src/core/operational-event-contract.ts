import type { Mode } from "../cli-args.ts";
import type { UpdateCheckResult } from "../update/check.ts";

/** Diagnostic events consumed as evidence by the artifact smoke. */
export const OPERATIONAL_EVENTS = {
  shellPainted: "app.boot.shell-painted",
  appPainted: "app.boot.painted",
  catalogLoadStarted: "catalog.load.started",
  markdownPreloadCompleted: "markdown.preload.completed",
  updateCheckSkipped: "update.check.skipped",
  updateAvailable: "update.available",
} as const;

type InteractiveMode = Extract<Mode, { kind: "run" | "resume" | "continue" }>["kind"];
type UpdateSkipReason = "disabled" | Extract<UpdateCheckResult, { kind: "skipped" }>["reason"];
type UpdateSource = Extract<UpdateCheckResult, { kind: "available" }>["source"];

/** Payloads keyed by their exact serialized event names. */
export interface OperationalEventPayloads {
  [OPERATIONAL_EVENTS.shellPainted]: { elapsed_ms: number; mode: InteractiveMode };
  [OPERATIONAL_EVENTS.appPainted]: {
    elapsed_ms: number;
    mode: InteractiveMode;
    deferred_catalog: boolean;
  };
  [OPERATIONAL_EVENTS.catalogLoadStarted]: { trigger: "catalog_surface" };
  [OPERATIONAL_EVENTS.markdownPreloadCompleted]: {
    markdown: boolean;
    markdownInline: boolean;
    duration_ms: number;
  };
  [OPERATIONAL_EVENTS.updateCheckSkipped]: { reason: UpdateSkipReason };
  [OPERATIONAL_EVENTS.updateAvailable]: {
    current_version: string;
    available_version: string;
    source: UpdateSource;
  };
}

export type OperationalEventName = keyof OperationalEventPayloads;
export type OperationalEvent = {
  [Name in OperationalEventName]: { event: Name; details: OperationalEventPayloads[Name] };
}[OperationalEventName];

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const duration = (value: unknown): boolean =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const interactiveMode = (value: unknown): boolean =>
  value === "run" || value === "resume" || value === "continue";
const string = (value: unknown): boolean => typeof value === "string";
const boolean = (value: unknown): boolean => typeof value === "boolean";

const fieldChecks = {
  [OPERATIONAL_EVENTS.shellPainted]: { elapsed_ms: duration, mode: interactiveMode },
  [OPERATIONAL_EVENTS.appPainted]: {
    elapsed_ms: duration,
    mode: interactiveMode,
    deferred_catalog: boolean,
  },
  [OPERATIONAL_EVENTS.catalogLoadStarted]: {
    trigger: (value: unknown): boolean => value === "catalog_surface",
  },
  [OPERATIONAL_EVENTS.markdownPreloadCompleted]: {
    markdown: boolean,
    markdownInline: boolean,
    duration_ms: duration,
  },
  [OPERATIONAL_EVENTS.updateCheckSkipped]: {
    reason: (value: unknown): boolean =>
      value === "disabled" ||
      value === "source" ||
      value === "unmanaged" ||
      value === "unsupported",
  },
  [OPERATIONAL_EVENTS.updateAvailable]: {
    current_version: string,
    available_version: string,
    source: (value: unknown): boolean => value === "cache" || value === "network",
  },
} satisfies {
  [Name in OperationalEventName]: Record<
    keyof OperationalEventPayloads[Name],
    (value: unknown) => boolean
  >;
};

/** Name the first invalid required field without exposing its value. */
export function invalidOperationalField(
  name: OperationalEventName,
  details: unknown,
): string | null {
  const value = object(details);
  if (value === null) return "details";
  for (const [field, check] of Object.entries(fieldChecks[name])) {
    if (!check(value[field])) return field;
  }
  return null;
}

/** Per-event guards checked against the payload map at compile time. */
export const OPERATIONAL_PAYLOAD_GUARDS = {
  [OPERATIONAL_EVENTS.shellPainted]: (
    value: unknown,
  ): value is OperationalEventPayloads["app.boot.shell-painted"] =>
    invalidOperationalField(OPERATIONAL_EVENTS.shellPainted, value) === null,
  [OPERATIONAL_EVENTS.appPainted]: (
    value: unknown,
  ): value is OperationalEventPayloads["app.boot.painted"] =>
    invalidOperationalField(OPERATIONAL_EVENTS.appPainted, value) === null,
  [OPERATIONAL_EVENTS.catalogLoadStarted]: (
    value: unknown,
  ): value is OperationalEventPayloads["catalog.load.started"] =>
    invalidOperationalField(OPERATIONAL_EVENTS.catalogLoadStarted, value) === null,
  [OPERATIONAL_EVENTS.markdownPreloadCompleted]: (
    value: unknown,
  ): value is OperationalEventPayloads["markdown.preload.completed"] =>
    invalidOperationalField(OPERATIONAL_EVENTS.markdownPreloadCompleted, value) === null,
  [OPERATIONAL_EVENTS.updateCheckSkipped]: (
    value: unknown,
  ): value is OperationalEventPayloads["update.check.skipped"] =>
    invalidOperationalField(OPERATIONAL_EVENTS.updateCheckSkipped, value) === null,
  [OPERATIONAL_EVENTS.updateAvailable]: (
    value: unknown,
  ): value is OperationalEventPayloads["update.available"] =>
    invalidOperationalField(OPERATIONAL_EVENTS.updateAvailable, value) === null,
} satisfies {
  [Name in OperationalEventName]: (value: unknown) => value is OperationalEventPayloads[Name];
};

/** Validate the payload belonging to one selected operational event. */
export function isOperationalPayload<Name extends OperationalEventName>(
  name: Name,
  value: unknown,
): value is OperationalEventPayloads[Name] {
  return OPERATIONAL_PAYLOAD_GUARDS[name](value);
}

/** Test whether an arbitrary diagnostic name belongs to the smoke contract. */
export function isOperationalEventName(value: unknown): value is OperationalEventName {
  return typeof value === "string" && Object.hasOwn(OPERATIONAL_PAYLOAD_GUARDS, value);
}
