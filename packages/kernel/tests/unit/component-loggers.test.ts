import { describe, expect, it } from "bun:test";
import { NOOP_LOGGER, type Logger } from "@clarvis/capability";
import { createComponentLoggers } from "../../src/component-loggers.ts";

interface Derived {
  bindings: Record<string, unknown>;
  level: string | undefined;
}

function pinoShaped(): { root: Logger; derived: Derived[] } {
  const derived: Derived[] = [];
  const leaf: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  const root = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    level: "info",
    child(bindings: Record<string, unknown>, options?: { level?: string }) {
      derived.push({ bindings, level: options?.level });
      return leaf;
    },
  } satisfies Logger;
  return { root, derived };
}

function bindingsOnly(): { root: Logger; derived: Record<string, unknown>[] } {
  const derived: Record<string, unknown>[] = [];
  const leaf: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  const root: Logger = {
    ...leaf,
    child: (bindings) => {
      derived.push(bindings);
      return leaf;
    },
  };
  return { root, derived };
}

describe("createComponentLoggers", () => {
  it("is all-silent when the host has no logger", () => {
    const forComponent = createComponentLoggers(undefined, "mcp=debug", "info");
    expect(forComponent("mcp")).toBe(NOOP_LOGGER);
  });

  it("binds the component name so a record can be attributed", () => {
    const { root, derived } = pinoShaped();
    createComponentLoggers(root, undefined, "info")("guard");
    expect(derived).toEqual([{ bindings: { component: "guard" }, level: "info" }]);
  });

  it("applies the scope's level to the component it names", () => {
    const { root, derived } = pinoShaped();
    const forComponent = createComponentLoggers(root, "mcp=debug,guard=error", "info");
    forComponent("mcp");
    forComponent("guard");
    forComponent("trace");
    expect(derived.map((d) => d.level)).toEqual(["debug", "error", "info"]);
  });

  it("covers a nested component through its prefix", () => {
    const { root, derived } = pinoShaped();
    createComponentLoggers(root, "mcp=debug", "warn")("mcp.connect");
    expect(derived[0]?.level).toBe("debug");
  });

  it("derives one logger per component and reuses it", () => {
    const { root, derived } = pinoShaped();
    const forComponent = createComponentLoggers(root, undefined, "info");
    const first = forComponent("config");
    const second = forComponent("config");
    expect(second).toBe(first);
    expect(derived).toHaveLength(1);
  });

  it("still binds when the backend's child takes bindings only", () => {
    const { root, derived } = bindingsOnly();
    const forComponent = createComponentLoggers(root, "config=debug", "info");
    expect(forComponent("config")).not.toBe(root);
    expect(derived).toEqual([{ component: "config" }]);
  });

  it("returns the root unchanged when the backend implements no child", () => {
    const root: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
    expect(createComponentLoggers(root, "config=debug", "info")("config")).toBe(root);
  });
});

describe("a silent root", () => {
  it("is not overridden by a CLARVIS_LOG scope", () => {
    // `componentFloor` guards only the fallback, and `levelFor` overrides a
    // fallback whenever a scope matches — so one CLARVIS_LOG=worktrees=debug in
    // the operator's environment pinned a child above the root @clarvis/code
    // had deliberately silenced, and wrote raw JSON over the rendered canvas.
    const { root, derived } = pinoShaped();
    const silent: Logger = { ...root, level: "silent" };
    const loggers = createComponentLoggers(silent, "worktrees=debug,config=info", "silent");
    expect(loggers("worktrees")).toBe(NOOP_LOGGER);
    expect(loggers("config")).toBe(NOOP_LOGGER);
    expect(derived).toEqual([]);
  });

  it("yields the same all-silent factory an absent root does", () => {
    const { root } = pinoShaped();
    expect(createComponentLoggers({ ...root, level: "silent" }, undefined, "info")("kernel")).toBe(
      NOOP_LOGGER,
    );
    expect(createComponentLoggers(undefined, undefined, "info")("kernel")).toBe(NOOP_LOGGER);
  });
});
