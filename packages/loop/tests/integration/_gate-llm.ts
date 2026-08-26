import type { LLMCallParams, LLMCallResult, LLMProvider } from "@clarvis/capability";

export class GateLLM implements LLMProvider {
  readonly calls: LLMCallParams[] = [];
  private readonly startedResolvers: Array<() => void> = [];
  private readonly startedPromises: Array<Promise<void>> = [];
  private readonly releasePromises: Array<Promise<void>> = [];
  private readonly releaseResolvers: Array<() => void> = [];

  constructor(
    private readonly onCall?: (callNo: number, params: LLMCallParams) => Partial<LLMCallResult>,
  ) {}

  private ensure(n: number): void {
    while (this.releasePromises.length <= n) {
      let rel!: () => void;
      this.releasePromises.push(new Promise<void>((r) => (rel = r)));
      this.releaseResolvers.push(rel);
      let start!: () => void;
      this.startedPromises.push(new Promise<void>((r) => (start = r)));
      this.startedResolvers.push(start);
    }
  }

  started(n: number): Promise<void> {
    this.ensure(n);
    return this.startedPromises[n]!;
  }

  release(n: number): void {
    this.ensure(n);
    this.releaseResolvers[n]!();
  }

  async call(params: LLMCallParams): Promise<LLMCallResult> {
    const i = this.calls.length;
    this.calls.push(params);
    this.ensure(i);
    this.startedResolvers[i]!();
    await this.releasePromises[i];
    const override = this.onCall?.(i, params) ?? {};
    return {
      toolCalls: override.toolCalls ?? [{ id: `c${i}`, name: "noop.tool", arguments: {} }],
      ...(override.text !== undefined ? { text: override.text } : {}),
      usage: override.usage ?? {
        input_tokens: 5,
        output_tokens: 5,
        cached_tokens: 0,
        cache_write_tokens: 0,
      },
    };
  }
}
