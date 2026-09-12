import { z } from "zod";
import type {
  ElicitRequest,
  GuardElicit,
  GuardJudgeConfig,
  LLMProvider,
  Logger,
  Message,
  ProviderConfig,
} from "@clarvis/loop";
import { parseModelRef, resolveProvider, type NamespacedTool } from "@clarvis/capability";

/** Fallback per-call timeout for the judge LLM when the config sets none. */
const DEFAULT_JUDGE_TIMEOUT_MS = 20_000;

/** Name of the single forced tool the judge must call to report its verdict. */
const DECIDE_TOOL_NAME = "decide";

/**
 * Lenient validator for the judge's `decide` arguments: a required
 * allow/deny/unsure `decision` and an optional `reason`. `.loose()` tolerates
 * any extra keys the model emits.
 */
const decideArgsSchema = z
  .object({
    decision: z.enum(["allow", "deny", "unsure"]),
    reason: z.string().optional(),
  })
  .loose();

/** The `decide` tool definition presented to (and forced on) the judge model. */
const DECIDE_TOOL: NamespacedTool = {
  fullName: DECIDE_TOOL_NAME,
  wireName: DECIDE_TOOL_NAME,
  mcpName: "",
  toolName: DECIDE_TOOL_NAME,
  description: "Report the verdict for the tool call under review.",
  inputSchema: {
    type: "object",
    required: ["decision"],
    additionalProperties: false,
    properties: {
      decision: { type: "string", enum: ["allow", "deny", "unsure"] },
      reason: { type: "string" },
    },
  },
};

/** Runtime dependencies for the guard judge LLM call. */
export interface JudgeDeps {
  /** Provider port used to run the judge model. */
  llm: LLMProvider;
  /** Configured providers, used to resolve the judge model's provider. */
  providers: ProviderConfig[];
  /** Fallback model token when {@link GuardJudgeConfig.model} is unset. */
  defaultModel: string | undefined;
  /** Optional sink for the warnings emitted when the judge degrades or fails. */
  logger?: Logger | undefined;
  /** Aborts the judge call when the run is cancelled. */
  signal?: AbortSignal | undefined;
  /** Host-captured start/continue user text, bounded by the resolver to 4 KiB. */
  operatorMessage?: string | undefined;
}

/**
 * Renders the tool call under review as the pretty-printed JSON user message the
 * judge scores — tool name, args, guard reason, and (for bash) the normalized
 * segments, the undecidable flag, and touched paths.
 */
function factsMessage(req: ElicitRequest): string {
  return JSON.stringify(
    {
      tool: req.tool,
      args: req.args,
      guard_reason: req.reason,
      segments: req.shell?.segments.map((s) => s.normalized),
      undecidable: req.shell?.undecidable,
      paths: req.shell?.paths,
      placement: req.placement,
      network: req.network,
      matched: req.matched,
      within_workspace: req.within_workspace,
      touches_outside: req.touches_outside,
      dangerous: req.dangerous,
      operator_message: req.operator_message || undefined,
    },
    null,
    2,
  );
}

/**
 * Key the exact reviewed facts, not merely normalized argv: cwd, raw expansions,
 * environment prefixes and host-attested policy facts can change a ruling.
 */
function memoKey(req: ElicitRequest): string {
  return factsMessage(req);
}

/** A parsed judge verdict: the decision plus an optional free-text reason. */
interface JudgeVerdict {
  decision: "allow" | "deny" | "unsure";
  reason?: string;
}

/**
 * Extracts the {@link JudgeVerdict} from the model's tool calls.
 *
 * @param toolCalls - the tool calls returned by the judge model.
 * @returns the parsed verdict, or `undefined` if the first call is not a valid
 *   `decide` call (string arguments are JSON-parsed first; malformed JSON or a
 *   schema mismatch yields `undefined`).
 */
function parseDecision(
  toolCalls: Array<{ name: string; arguments: unknown }> | undefined,
): JudgeVerdict | undefined {
  const call = toolCalls?.[0];
  if (call === undefined || call.name !== DECIDE_TOOL_NAME) return undefined;
  const raw =
    typeof call.arguments === "string"
      ? (() => {
          try {
            return JSON.parse(call.arguments) as unknown;
          } catch {
            return undefined;
          }
        })()
      : call.arguments;
  const parsed = decideArgsSchema.safeParse(raw);
  return parsed.success
    ? {
        decision: parsed.data.decision,
        ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
      }
    : undefined;
}

/** The channel that ultimately answered one automated-review attempt. */
export interface JudgeElicitAnswer {
  /** Whether the guarded call may proceed. */
  allowed: boolean;
  /** The judge itself, or the human fallback used after an inconclusive review. */
  answerer: "judge" | "human";
}

/** Judge channel enriched with its final answerer so audit attribution remains truthful. */
export type JudgeElicit = (req: ElicitRequest) => Promise<JudgeElicitAnswer>;

function allowedFromElicit(answer: Awaited<ReturnType<GuardElicit>>): boolean {
  return answer === true || (typeof answer === "object" && answer.allowed === true);
}

/**
 * Builds an auto-mode guard elicit that asks an LLM to allow/deny/unsure (memoized per command key).
 * Returns `undefined` if the judge model cannot be resolved. On `unsure`, a call failure, or a
 * malformed response, it escalates to `humanElicit` when configured and policy permits; otherwise
 * it denies.
 *
 * @param deps - LLM port, providers, default model, and optional logger/signal;
 *   see {@link JudgeDeps}.
 * @param cfg - the judge configuration: model, system prompt, timeout, and the
 *   `on_unsure` policy.
 * @param humanElicit - the human fallback invoked on `unsure` when
 *   {@link GuardJudgeConfig.on_unsure} is not `"deny"`; may be `undefined`.
 * @returns a {@link JudgeElicit}, or `undefined` when no judge model resolves
 *   (no configured or default model, or an unresolvable provider) — the caller
 *   then degrades to mode `on`.
 * @remarks Each distinct command ({@link memoKey}) is judged once and its
 *   verdict cached. A call/parse failure is *not* cached, so a later attempt can retry even when a
 *   human answered the failed attempt. Human fallback answers are never retained as judge verdicts;
 *   their lifetime belongs to the host's current consent scope. A rejected promise is evicted.
 */
export function createJudgeElicit(
  deps: JudgeDeps,
  cfg: GuardJudgeConfig,
  humanElicit: GuardElicit | undefined,
): JudgeElicit | undefined {
  const modelToken = cfg.model ?? deps.defaultModel;
  if (modelToken === undefined) {
    deps.logger?.warn(
      {},
      "guard_judge: no judge model (guard_judge.model or settings default_model) — degrading to mode 'on'",
    );
    return undefined;
  }
  const ref = parseModelRef(modelToken);
  const resolution = resolveProvider(ref.provider, deps.providers, ref.modelId);
  if (resolution.ok === false) {
    deps.logger?.warn(
      { model: modelToken },
      `guard_judge: ${resolution.message} — degrading to mode 'on'`,
    );
    return undefined;
  }
  const escalate = cfg.on_unsure !== "deny";
  const verdicts = new Map<string, Promise<JudgeElicitAnswer>>();

  const fallback = async (req: ElicitRequest, note: string): Promise<JudgeElicitAnswer> => {
    if (!escalate || humanElicit === undefined) return { allowed: false, answerer: "judge" };
    const reason = req.reason ? `${req.reason}\n\n${note}` : note;
    return {
      allowed: allowedFromElicit(await humanElicit({ ...req, reason })),
      answerer: "human",
    };
  };

  const judgeOnce = async (
    req: ElicitRequest,
  ): Promise<{ value: JudgeElicitAnswer; clean: boolean }> => {
    const messages: Message[] = [
      { role: "system", content: cfg.prompt },
      { role: "user", content: factsMessage(req) },
    ];
    let verdict: JudgeVerdict | undefined;
    try {
      const result = await deps.llm.call({
        model: ref.modelId,
        provider: ref.provider,
        providerConfig: resolution.config,
        messages,
        tools: [DECIDE_TOOL],
        toolChoice: { type: "function", function: { name: DECIDE_TOOL_NAME } },
        timeoutMs: cfg.timeout_ms ?? DEFAULT_JUDGE_TIMEOUT_MS,
        ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
      });
      verdict = parseDecision(result.toolCalls);
    } catch (err) {
      deps.logger?.warn(
        { tool: req.tool, error: err instanceof Error ? err.message : String(err) },
        "guard_judge: judge call failed — escalating to the human channel when available",
      );
      return {
        value: await fallback(req, "The automated reviewer failed, so this decision needs you."),
        clean: false,
      };
    }
    if (verdict?.decision === "allow")
      return { value: { allowed: true, answerer: "judge" }, clean: true };
    if (verdict?.decision === "deny")
      return { value: { allowed: false, answerer: "judge" }, clean: true };
    if (verdict === undefined) {
      deps.logger?.warn(
        { tool: req.tool },
        "guard_judge: malformed judge response — escalating to the human channel when available",
      );
      return {
        value: await fallback(
          req,
          "The automated reviewer returned an invalid decision, so this decision needs you.",
        ),
        clean: false,
      };
    }
    if (escalate && humanElicit !== undefined) {
      const note =
        "The automated reviewer was unsure and escalated this to you" +
        (verdict.reason ? ` (${verdict.reason})` : "") +
        ".";
      const escalated = { ...req, reason: req.reason ? `${req.reason}\n\n${note}` : note };
      return {
        value: {
          allowed: allowedFromElicit(await humanElicit(escalated)),
          answerer: "human",
        },
        clean: true,
      };
    }
    return { value: { allowed: false, answerer: "judge" }, clean: true };
  };

  return (request) => {
    const req = {
      ...request,
      ...(deps.operatorMessage !== undefined ? { operator_message: deps.operatorMessage } : {}),
    };
    const key = memoKey(req);
    const cached = verdicts.get(key);
    if (cached !== undefined) return cached;
    const verdict = judgeOnce(req).then(
      (r) => {
        if (!r.clean || r.value.answerer === "human") verdicts.delete(key);
        return r.value;
      },
      (err: unknown) => {
        verdicts.delete(key);
        throw err;
      },
    );
    verdicts.set(key, verdict);
    return verdict;
  };
}
