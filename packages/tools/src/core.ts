import { Ajv, type ValidateFunction } from "ajv";
import { randomUUID } from "node:crypto";
import { ToolError, serializeError } from "./errors.ts";
import { bound } from "./lib/output.ts";
import { tools, getTool, selectSurface } from "./tools/registry.ts";
import { textPart, type ContentPart, type ToolResult } from "./tools/content.ts";
import type { ToolCallHooks } from "./tools/types.ts";
import type { RuntimeConfig } from "./config.ts";
import { hostToolExecutor } from "./execution/host.ts";
import { prepareToolAction } from "./execution/action.ts";

const ajv = new Ajv({ allErrors: true, useDefaults: true, coerceTypes: true });
const validators = new Map<string, ValidateFunction>();
for (const tool of tools) {
  validators.set(tool.name, ajv.compile(tool.inputSchema));
}

/**
 * The outcome of a single tool call: whether it failed, the content parts to
 * return, and any tool-supplied metadata. An error is reported in-band (as
 * `isError: true` with a serialized error text part), not by throwing.
 */
export interface DispatchResult {
  isError: boolean;
  content: ContentPart[];
  meta?: Record<string, unknown>;
}

function normalizeOutput(out: string | ToolResult): ToolResult {
  return typeof out === "string" ? { content: out } : out;
}

function errorResult(err: unknown, maxMetaBytes?: number): DispatchResult {
  const fields = err instanceof ToolError ? err.fields : undefined;
  const sandboxError = fields?.execution_mode === "sandbox" && typeof fields.policy_id === "string";
  const meta =
    (sandboxError || fields?.requested_mode === "sandbox") && typeof fields?.policy_id === "string"
      ? {
          requested_mode: "sandbox",
          effective_mode: fields.effective_mode === "host" ? "host" : "sandbox",
          sandbox_fallback: fields.sandbox_fallback === true,
          attempt_id: typeof fields.attempt_id === "string" ? fields.attempt_id : randomUUID(),
          ...Object.fromEntries(
            ["execution_backend", "policy_id", "execution_started", "attempts", "fallback_reason"]
              .filter((key) => fields[key] !== undefined)
              .map((key) => [key, fields[key]]),
          ),
        }
      : undefined;
  return {
    isError: true,
    content: [textPart(serializeError(err))],
    ...(meta === undefined
      ? {}
      : { meta: maxMetaBytes === undefined ? meta : boundMeta(meta, maxMetaBytes) }),
  };
}

function boundParts(
  parts: ContentPart[],
  bounded: boolean | undefined,
  maxOutputBytes: number,
): ContentPart[] {
  if (bounded) return parts;
  return parts.map((p) => (p.type === "text" ? textPart(bound(p.text, maxOutputBytes)) : p));
}

function boundMeta(meta: Record<string, unknown>, maxBytes: number): Record<string, unknown> {
  const encoded = JSON.stringify(meta);
  if (Buffer.byteLength(encoded, "utf8") <= maxBytes) return meta;
  const identity = Object.fromEntries(
    [
      "execution_mode",
      "execution_backend",
      "policy_id",
      "execution_started",
      "sandbox_fallback",
      "execution_diagnostic",
      "requested_mode",
      "effective_mode",
      "attempt_id",
      "attempts",
      "fallback_reason",
    ]
      .filter((key) => meta[key] !== undefined)
      .map((key) => [key, meta[key]]),
  );
  let base: Record<string, unknown> = {
    ...identity,
    truncated: true,
    truncation_reason: `tool metadata exceeded ${String(maxBytes)} bytes`,
  };
  if (Buffer.byteLength(JSON.stringify(base), "utf8") > maxBytes) {
    const diagnostic = base.execution_diagnostic;
    if (typeof diagnostic === "object" && diagnostic !== null && !Array.isArray(diagnostic)) {
      const withoutStreams = { ...diagnostic } as Record<string, unknown>;
      delete withoutStreams.stdout;
      delete withoutStreams.stderr;
      base = { ...base, execution_diagnostic: withoutStreams };
    }
  }
  if (Buffer.byteLength(JSON.stringify(base), "utf8") > maxBytes) {
    delete base.execution_diagnostic;
  }
  if (Buffer.byteLength(JSON.stringify(base), "utf8") > maxBytes) {
    delete base.attempts;
  }
  if (Buffer.byteLength(JSON.stringify(base), "utf8") > maxBytes) {
    base = { truncated: true, truncation_reason: base.truncation_reason };
  }
  const diff = typeof meta.diff === "string" ? meta.diff : undefined;
  if (diff === undefined) return base;

  const suffix = "\n[diff truncated to metadata budget]";
  let low = 0;
  let high = diff.length;
  let best: Record<string, unknown> = base;
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const candidate = { diff: `${diff.slice(0, midpoint)}${suffix}`, ...base };
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= maxBytes) {
      best = candidate;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }
  return best;
}

/**
 * The public description of a tool as advertised to a client/model: its name,
 * description, and argument schema, without the handler.
 */
export interface ToolInfo {
  /** The tool's dispatch name. */
  name: string;
  /** The human-readable description shown to the model. */
  description: string;
  /** The JSON Schema for the tool's arguments. */
  inputSchema: Record<string, unknown>;
}

/**
 * List the tools available under a given config.
 *
 * @param config - the resolved server config; its `readOnly` flag selects the
 *   surface.
 * @returns the advertised {@link ToolInfo} for each tool in the effective
 *   surface (see {@link selectSurface}).
 */
export function listTools(config: RuntimeConfig): ToolInfo[] {
  return selectSurface(config.readOnly).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

/**
 * Validate and execute a single tool call, returning its result.
 *
 * @param name - the tool to invoke.
 * @param args - the raw caller arguments; a clone is validated (and mutated by
 *   defaulting/coercion) against the tool's schema before the handler sees it,
 *   so the caller's object is left untouched (see the `@remarks`).
 * @param config - the resolved server config selecting the surface and limits.
 * @param signal - optional abort signal forwarded to the handler.
 * @param hooks - optional {@link ToolCallHooks} for live output.
 * @returns a {@link DispatchResult}; failures are reported in-band as
 *   `isError: true`, never thrown. Unknown tools yield `not_found`, schema
 *   violations `invalid_input`, and a throwing
 *   handler its {@link serializeError} rendering.
 * @remarks Text parts of a non-`bounded` tool are clamped to
 *   {@link RuntimeConfig.maxOutputBytes}; a `bounded` tool's output passes
 *   through untouched. Arguments are `structuredClone`d before validation, so
 *   the caller's object is not mutated.
 */
export async function dispatch(
  name: string,
  args: Record<string, unknown>,
  config: RuntimeConfig,
  signal?: AbortSignal,
  hooks?: ToolCallHooks,
): Promise<DispatchResult> {
  const tool = getTool(name, selectSurface(config.readOnly));
  if (!tool) {
    return errorResult(new ToolError("not_found", `Unknown tool: ${name}`));
  }

  const validate = validators.get(name)!;
  const filled = structuredClone(args);
  if (!validate(filled)) {
    const detail = ajv.errorsText(validate.errors, { separator: "; " });
    return errorResult(new ToolError("invalid_input", detail || "invalid arguments"));
  }

  let recordAttempt:
    | ((
        phase: "admitted" | "started" | "settled" | "uncertain",
        backend?: "host" | "bubblewrap" | "seatbelt",
      ) => void)
    | undefined;
  try {
    let executionConfig = config;
    if (config.actionAuthorization && name !== "shell_session") {
      const identity = config.actionIdentity;
      if (!identity || !hooks?.actionCallId || !hooks.actionActor) {
        throw new ToolError("invalid_input", "Trusted action identity is missing");
      }
      const action = await prepareToolAction(name, filled, config);
      const requestedProfile: "sandbox" | "host" =
        config.executionPolicy?.mode === "sandbox" ? "sandbox" : "host";
      let request = {
        identity: { ...identity, actor: hooks.actionActor, callId: hooks.actionCallId, attempt: 1 },
        tool: name,
        arguments: structuredClone(filled),
        ...(action.command === undefined ? {} : { command: action.command }),
        ...(action.shell === undefined ? {} : { shell: action.shell }),
        ...(action.cwd === undefined ? {} : { cwd: action.cwd }),
        ...(action.environment === undefined ? {} : { environment: action.environment }),
        paths: action.paths,
        requestedProfile,
        effectiveProfile: requestedProfile,
        ...(action.permissions === undefined ? {} : { permissions: action.permissions }),
        reason: action.reason,
        policyRevision: config.actionAuthorization.policyRevision,
        authorizationRevision: config.actionAuthorization.revision(),
      };
      let decision:
        | Awaited<ReturnType<NonNullable<typeof config.actionAuthorization>["authorize"]>>
        | undefined;
      for (let review = 0; review < 3; review++) {
        try {
          decision = await config.actionAuthorization.authorize(request, signal);
        } catch (error) {
          if (
            signal?.aborted ||
            config.actionAuthorization.revision() === request.authorizationRevision ||
            review === 2
          )
            throw error;
          request = {
            ...request,
            policyRevision: config.actionAuthorization.policyRevision,
            authorizationRevision: config.actionAuthorization.revision(),
          };
          continue;
        }
        if (
          config.actionAuthorization.revision() !== request.authorizationRevision &&
          !signal?.aborted &&
          review < 2
        ) {
          request = {
            ...request,
            policyRevision: config.actionAuthorization.policyRevision,
            authorizationRevision: config.actionAuthorization.revision(),
          };
          continue;
        }
        break;
      }
      if (
        !decision ||
        !decision.granted ||
        !config.actionAuthorization.valid(request, decision) ||
        signal?.aborted
      ) {
        throw new ToolError(
          "sandbox_denied",
          `Action denied: ${decision?.evidence.reason ?? "review_unavailable"}`,
        );
      }
      const selected = config.selectAuthorizedExecution?.(decision.permissions);
      recordAttempt = (phase, backend) =>
        config.actionAuthorization?.recordAttempt?.(
          request,
          phase,
          backend,
          decision.evidence.effectiveProfile,
        );
      recordAttempt("admitted");
      executionConfig = {
        ...config,
        ...(selected ?? {}),
        actionValid: () => config.actionAuthorization!.valid(request, decision) && !signal?.aborted,
        actionStarted: (backend) => recordAttempt?.("started", backend),
      };
    }
    const executor = executionConfig.executionPort ?? hostToolExecutor;
    const { content, meta } = normalizeOutput(
      await executor.execute(tool, filled, executionConfig, signal, hooks),
    );
    recordAttempt?.(
      "settled",
      executionConfig.executionPolicy?.mode === "sandbox"
        ? executionConfig.sandboxBackend?.name
        : "host",
    );
    const parts = typeof content === "string" ? [textPart(content)] : content;
    return {
      isError: false,
      content: boundParts(parts, tool.bounded, config.maxOutputBytes),
      ...(meta ? { meta: boundMeta(meta, config.maxToolMetaBytes) } : {}),
    };
  } catch (err) {
    recordAttempt?.(
      err instanceof ToolError && err.code === "outcome_unknown" ? "uncertain" : "settled",
    );
    const failed = errorResult(err, config.maxToolMetaBytes);
    return failed;
  }
}
