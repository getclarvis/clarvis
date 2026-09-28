import {
  OPERATIONAL_PAYLOAD_GUARDS,
  invalidOperationalField,
  isOperationalEventName,
  isOperationalPayload,
  type OperationalEventName,
  type OperationalEventPayloads,
} from "#src/core/operational-event-contract.ts";

/** One file's complete diagnostic evidence, before the fixture chooses another file. */
export type DiagnosticSelection<Name extends OperationalEventName> =
  | { kind: "found"; details: OperationalEventPayloads[Name] }
  | { kind: "absent" }
  | { kind: "pending"; file: string }
  | { kind: "invalid"; file: string; event: string; field: string };

/** Select a validated event from one JSONL snapshot without reading files or exposing values. */
export function selectDiagnosticEvent<Name extends OperationalEventName>(
  content: string,
  file: string,
  event: Name,
): DiagnosticSelection<Name> {
  const lines = content.split("\n");
  const tail = lines.pop() ?? "";
  let found: OperationalEventPayloads[Name] | undefined;
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      return { kind: "invalid", file, event: "<jsonl>", field: "line" };
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { kind: "invalid", file, event: "<jsonl>", field: "record" };
    }
    const record = parsed as Record<string, unknown>;
    if (typeof record.event !== "string") {
      return { kind: "invalid", file, event: "<jsonl>", field: "event" };
    }
    if (record.event === event) {
      if (!isOperationalPayload(event, record.details)) {
        return {
          kind: "invalid",
          file,
          event: record.event,
          field: invalidOperationalField(event, record.details) ?? "details",
        };
      }
      found ??= record.details;
    } else if (
      isOperationalEventName(record.event) &&
      !OPERATIONAL_PAYLOAD_GUARDS[record.event](record.details)
    ) {
      return {
        kind: "invalid",
        file,
        event: record.event,
        field: invalidOperationalField(record.event, record.details) ?? "details",
      };
    }
  }
  if (tail.length > 0) return { kind: "pending", file };
  return found === undefined ? { kind: "absent" } : { kind: "found", details: found };
}
