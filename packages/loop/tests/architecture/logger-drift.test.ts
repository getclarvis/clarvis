/**
 * `@clarvis/tools` declares its own `ToolsLogger` rather than importing
 * `@clarvis/capability`'s `Logger`, so that its only internal dependency stays
 * `@clarvis/paths`. `@clarvis/hooks` set the same precedent with `HookLogger`.
 * That independence is only free while the shapes stay compatible, and neither
 * package can see both.
 *
 * @remarks This test lives here because `@clarvis/loop` is the lowest package
 * that depends on all three, and because the coupling is real:
 * `runtime/capabilities/tools.ts` hands `AgentLoopContext.logger` — a capability
 * `Logger` — straight to `createAgentTools`, whose option is typed
 * `ToolsLogger`. A member added to either feature port, or a signature narrowed
 * on it, breaks that call; asserting it here names the invariant instead of
 * leaving a downstream compile error to imply it.
 *
 * Only one direction is asserted. A host holding the contract's `Logger` must
 * satisfy every feature port; the reverse is deliberately not required, since
 * `Logger` carries `child` and `level` that a minimal sink need not implement.
 */
import { describe, expect, it } from "../bun-test.ts";
import type { Logger, LogFn } from "@clarvis/capability";
import type { ToolsLogger } from "@clarvis/tools";
import type { HookLogger } from "@clarvis/hooks";

/** Compile-time assertion that `T` is assignable to `U`. */
type Assignable<T extends U, U> = [T, U];

type _ToolsAcceptsContractLogger = Assignable<Logger, ToolsLogger>;
type _HooksAcceptsContractLogger = Assignable<Logger, HookLogger>;

/** A `LogFn` that records the level it was reached through. */
function recorder(level: string, sink: { level: string; msg: string }[]): LogFn {
  return ((first: unknown, second?: string): void => {
    sink.push({ level, msg: typeof first === "string" ? first : (second ?? "") });
  }) as LogFn;
}

describe("logger port drift", () => {
  it("lets a contract Logger stand in for every feature package's logger port", () => {
    const record: { level: string; msg: string }[] = [];
    const logger: Logger = {
      debug: recorder("debug", record),
      info: recorder("info", record),
      warn: recorder("warn", record),
      error: recorder("error", record),
    };

    const asTools: ToolsLogger = logger;
    const asHooks: HookLogger = logger;
    asTools.warn({ event: "tools.probe" }, "from tools");
    asHooks.debug({ event: "hooks.probe" }, "from hooks");

    expect(record).toEqual([
      { level: "warn", msg: "from tools" },
      { level: "debug", msg: "from hooks" },
    ]);
  });

  it("keeps the optional Logger members from breaking either feature port", () => {
    const seen: string[] = [];
    const base: Logger = {
      debug: recorder("debug", []),
      info: recorder("info", []),
      warn: recorder("warn", []),
      error: recorder("error", []),
      level: "debug",
      child(bindings) {
        seen.push(JSON.stringify(bindings));
        return base;
      },
    };

    // A `child`-derived logger must still satisfy both ports.
    const derived: Logger = base.child!({ execution_id: "x" });
    const asTools: ToolsLogger = derived;
    const asHooks: HookLogger = derived;

    expect(seen).toEqual(['{"execution_id":"x"}']);
    for (const level of ["debug", "info", "warn", "error"] as const) {
      expect(typeof asTools[level]).toBe("function");
      expect(typeof asHooks[level]).toBe("function");
    }
  });
});
