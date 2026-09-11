import type { LogFn, Logger } from "@clarvis/capability";

type AuditLevel = "info" | "warn";

const DECISION_MATCHES = new Set([
  "deny_list",
  "allow_list",
  "undecidable",
  "outside_workspace",
  "credential_file",
  "host_command",
  "non_bash",
  "default",
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function boundedString(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.length <= maximum ? value : undefined;
}

function invalidAudit(): never {
  throw Object.assign(new Error("runtime guard audit envelope is invalid"), {
    code: "invalid_request",
  });
}

function decision(fields: Record<string, unknown>): Record<string, unknown> {
  const verdict = boundedString(fields.verdict, 5);
  const matched = boundedString(fields.matched, 32);
  const mode = boundedString(fields.mode, 4);
  const tool = boundedString(fields.tool, 128);
  if (
    !["allow", "deny", "ask"].includes(verdict ?? "") ||
    !DECISION_MATCHES.has(matched ?? "") ||
    !["on", "auto"].includes(mode ?? "") ||
    tool === undefined
  ) {
    return invalidAudit();
  }
  const reason = boundedString(fields.reason, 2_048);
  const escalate = boundedString(fields.escalate, 5);
  const commandDigest = boundedString(fields.command_digest, 16);
  if (
    (fields.reason !== undefined && reason === undefined) ||
    (fields.escalate !== undefined && escalate !== "human") ||
    (fields.command_digest !== undefined && !/^[a-f0-9]{16}$/u.test(commandDigest ?? ""))
  ) {
    return invalidAudit();
  }
  return {
    event: "guard.decision",
    verdict,
    matched,
    mode,
    tool,
    ...(reason === undefined ? {} : { reason }),
    ...(escalate === undefined ? {} : { escalate }),
    ...(commandDigest === undefined ? {} : { command_digest: commandDigest }),
  };
}

function resolved(fields: Record<string, unknown>): Record<string, unknown> {
  const mode = boundedString(fields.mode, 4);
  const source = boundedString(fields.source, 8);
  if (
    !["on", "auto"].includes(mode ?? "") ||
    !["request", "settings"].includes(source ?? "") ||
    typeof fields.judge_configured !== "boolean" ||
    typeof fields.human_channel !== "boolean"
  ) {
    return invalidAudit();
  }
  return {
    event: "guard.resolved",
    mode,
    source,
    judge_configured: fields.judge_configured,
    human_channel: fields.human_channel,
  };
}

function answered(fields: Record<string, unknown>): Record<string, unknown> {
  const answer = boundedString(fields.answer, 13);
  const answerer = boundedString(fields.answerer, 17);
  if (
    !["allow", "allow_session", "deny"].includes(answer ?? "") ||
    !["human", "judge", "session_allowlist"].includes(answerer ?? "")
  ) {
    return invalidAudit();
  }
  return { event: "guard.elicit.answered", answer, answerer };
}

function sanitize(fields: Record<string, unknown>, level: AuditLevel): Record<string, unknown> {
  if (fields.event === "guard.decision" && level === "info") return decision(fields);
  if (fields.event === "guard.resolved" && level === "info") return resolved(fields);
  if (fields.event === "guard.elicit.answered" && level === "info") return answered(fields);
  if (fields.event === "guard.escalation.no_channel" && level === "warn") {
    return { event: "guard.escalation.no_channel" };
  }
  return invalidAudit();
}

function guestLog(
  enqueue: (event: unknown) => void,
  level: AuditLevel,
  bindings: Readonly<Record<string, unknown>>,
): LogFn {
  return (value: unknown): void => {
    const fields = record(value) ?? {};
    enqueue({ channel: "guard_audit", level, fields: { ...bindings, ...fields } });
  };
}

/** Build the synchronous Logger port whose records are serialized on the guest event queue. */
export function createGuestGuardAuditLogger(enqueue: (event: unknown) => void): Logger {
  const build = (bindings: Readonly<Record<string, unknown>>): Logger => ({
    debug: () => undefined,
    info: guestLog(enqueue, "info", bindings),
    warn: guestLog(enqueue, "warn", bindings),
    error: () => undefined,
    child: (next) => build({ ...bindings, ...next }),
    level: "info",
  });
  return build({});
}

/**
 * Validate one guest guard-audit event and write it through the host's dedicated audit logger.
 *
 * @returns `false` when the value belongs to another guest event channel, otherwise `true`.
 * @remarks Guest-provided owner and run fields are discarded; the authenticated host route binds
 * those identities again before writing the record.
 */
export function forwardGuestGuardAudit(
  value: unknown,
  audit: Logger,
  runId: string,
  owner: string,
): boolean {
  const envelope = record(value);
  if (envelope?.channel !== "guard_audit") return false;
  if (envelope.level !== "info" && envelope.level !== "warn") return invalidAudit();
  const fields = record(envelope.fields);
  if (fields === undefined) return invalidAudit();
  const sanitized: Record<string, unknown> = {
    ...sanitize(fields, envelope.level),
    run_id: runId,
    owner,
  };
  const messages: Readonly<Record<string, string>> = {
    "guard.decision": "the command guard ruled on a guest tool call",
    "guard.resolved": "the guest run command guard was resolved",
    "guard.elicit.answered": "a guarded guest command was answered",
    "guard.escalation.no_channel": "a guest command needed an unavailable human decision channel",
  };
  audit[envelope.level](sanitized, messages[String(sanitized["event"])]);
  return true;
}
