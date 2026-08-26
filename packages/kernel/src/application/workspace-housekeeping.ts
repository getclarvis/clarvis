import { detachObserved, type Logger } from "@clarvis/capability";

const DEFAULT_WORKSPACE_HOUSEKEEPING_INTERVAL_MS = 30 * 60_000;

/** Long-lived, bounded filesystem collectors owned by one workspace kernel. */
export class WorkspaceHousekeeping {
  private timer: ReturnType<typeof setInterval> | undefined;
  private active: Promise<void> | undefined;

  constructor(
    private readonly options: {
      sweepSpills: () => Promise<void>;
      sweepMonitors: () => Promise<void>;
      sweepGlobalArtifacts?: () => Promise<void>;
      logger?: Logger;
    },
  ) {}

  /** Run once now and then periodically; repeated starts are idempotent. */
  start(intervalMs = DEFAULT_WORKSPACE_HOUSEKEEPING_INTERVAL_MS): void {
    if (this.timer !== undefined) return;
    const run = (): void =>
      detachObserved(() => this.runOnce(), {
        operation: "workspace_housekeeping",
        ...(this.options.logger === undefined ? {} : { logger: this.options.logger }),
      });
    run();
    this.timer = setInterval(run, Math.max(1, intervalMs));
    this.timer.unref?.();
  }

  /** Coalesce overlapping requests onto the one pass already in flight. */
  runOnce(): Promise<void> {
    if (this.active !== undefined) return this.active;
    const collectors: Array<{ name: string; run: () => Promise<void> }> = [
      { name: "spills", run: this.options.sweepSpills },
      { name: "monitors", run: this.options.sweepMonitors },
      ...(this.options.sweepGlobalArtifacts === undefined
        ? []
        : [{ name: "global_artifacts", run: this.options.sweepGlobalArtifacts }]),
    ];
    const active = Promise.allSettled(collectors.map((collector) => collector.run()))
      .then((results) => {
        for (const [index, result] of results.entries()) {
          if (result.status === "fulfilled") continue;
          const collector = collectors[index];
          if (collector === undefined) continue;
          this.options.logger?.warn(
            {
              collector: collector.name,
              cause: result.reason instanceof Error ? result.reason.message : String(result.reason),
            },
            "workspace housekeeping collector failed; it will retry next interval",
          );
        }
      })
      .finally(() => {
        if (this.active === active) this.active = undefined;
      });
    this.active = active;
    return active;
  }

  /** Stop scheduling and wait for the current bounded pass to finish. */
  async stop(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.active;
  }
}
