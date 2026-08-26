import type {
  AssistantReasoningPart,
  LLMCallParams,
  LLMCallResult,
  LLMProvider,
} from "@clarvis/capability";

/**
 * One scripted turn of a {@link MockLLM}: the response it returns (or the error
 * it throws) when consumed.
 *
 * @remarks `throw` short-circuits after any `delayMs`, so a step models either a
 *   response or a failure. Omitted `usage` fields default in
 *   {@link MockLLM.call}.
 */
export interface MockLLMScriptStep {
  text?: string;
  reasoning?: string;
  reasoningParts?: AssistantReasoningPart[];
  toolCalls?: Array<{ id?: string; name: string; arguments?: unknown }>;
  usage?: Partial<{
    input_tokens: number;
    output_tokens: number;
    cached_tokens: number;
    cache_write_tokens: number;
  }>;
  throw?: Error;
  delayMs?: number;
  /** The provider's stop reason; `"length"` is how a truncated answer is reported. */
  finishReason?: string;
}

/**
 * Construction options for {@link MockLLM}.
 *
 * @remarks `script` is consumed one step per call, in order; exhausting it makes
 *   the next call throw.
 */
export interface MockLLMOptions {
  script: MockLLMScriptStep[];
  /**
   * Independently-cursored scripts, each claiming the calls its `when` matches.
   *
   * @remarks The bare `script` is one global cursor, which can only express a
   * tree whose agents take strict turns — fine while a spawn blocks its parent,
   * and wrong the moment one does not: a parent and a background child are
   * genuinely concurrent, and a single cursor hands whichever gets there first
   * the other's lines. A route gives each agent its own script, so a test can
   * say what the *manager* says without predicting when the leader speaks.
   *
   * Routes are tried in order; a call matching none falls back to `script`.
   */
  routes?: readonly MockLLMRoute[];
}

/** One independently-cursored script and the calls it claims. */
export interface MockLLMRoute {
  /** A label used in the exhaustion error, so a drained route names itself. */
  name: string;
  when: (params: LLMCallParams) => boolean;
  script: MockLLMScriptStep[];
}

/**
 * Scripted LLMProvider double: each call consumes the next step in order and
 * records the received params (with a deep-cloned message snapshot). Shared
 * through `./testing` so downstream suites exercise the same wire shape.
 */
export class MockLLM implements LLMProvider {
  /** Every call's params, captured with a deep-cloned `messages` snapshot for assertions. */
  readonly calls: LLMCallParams[] = [];
  private cursor = 0;
  private readonly routeCursors = new Map<string, number>();
  constructor(private readonly opts: MockLLMOptions) {}

  /**
   * Consumes and replays the next scripted step for one provider call.
   *
   * @param params - the call params; recorded (with cloned messages) into
   *   {@link MockLLM.calls} before the step is consumed.
   * @returns the step's result: `text`/`reasoning`, tool calls (each defaulting
   *   its `id` to `call_<index>` and `arguments` to `{}`), and usage counts with
   *   defaults (`10`/`5`/`0`/`0`) for omitted fields.
   * @throws the step's `throw` error, or an exhaustion `Error` once the script
   *   runs out.
   * @remarks Honors a step's `delayMs` before returning or throwing, and honors
   *   the provider signal during that delay so timeout tests cannot accidentally
   *   prove that detached model work is acceptable.
   */
  async call(params: LLMCallParams): Promise<LLMCallResult> {
    this.calls.push({ ...params, messages: structuredClone(params.messages) });
    const route = this.opts.routes?.find((r) => r.when(params));
    let step: MockLLMScriptStep | undefined;
    if (route === undefined) {
      step = this.opts.script[this.cursor];
      if (!step) {
        throw new Error(`MockLLM exhausted (call #${this.cursor + 1}); add more script steps.`);
      }
      this.cursor += 1;
    } else {
      const at = this.routeCursors.get(route.name) ?? 0;
      step = route.script[at];
      if (!step) {
        throw new Error(
          `MockLLM route '${route.name}' exhausted (call #${String(at + 1)}); add more steps.`,
        );
      }
      this.routeCursors.set(route.name, at + 1);
    }
    if (params.signal?.aborted === true) {
      throw params.signal.reason instanceof Error
        ? params.signal.reason
        : new DOMException("Mock model call aborted.", "AbortError");
    }
    if (step.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          clearTimeout(timer);
          reject(
            params.signal?.reason instanceof Error
              ? params.signal.reason
              : new DOMException("Mock model call aborted.", "AbortError"),
          );
        };
        const timer = setTimeout(() => {
          params.signal?.removeEventListener("abort", onAbort);
          resolve();
        }, step.delayMs);
        params.signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    if (step.throw) throw step.throw;
    return {
      text: step.text,
      ...(step.reasoning !== undefined ? { reasoning: step.reasoning } : {}),
      ...(step.reasoningParts !== undefined ? { reasoningParts: step.reasoningParts } : {}),
      ...(step.finishReason !== undefined ? { finishReason: step.finishReason } : {}),
      toolCalls: step.toolCalls?.map((tc, i) => ({
        id: tc.id ?? `call_${i}`,
        name: tc.name,
        arguments: tc.arguments ?? {},
      })),
      usage: {
        input_tokens: step.usage?.input_tokens ?? 10,
        output_tokens: step.usage?.output_tokens ?? 5,
        cached_tokens: step.usage?.cached_tokens ?? 0,
        cache_write_tokens: step.usage?.cache_write_tokens ?? 0,
      },
    };
  }
}
