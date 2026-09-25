import { describe, expect, it } from "bun:test";
import {
  deriveRunControls,
  memoryDescription,
  memoryState,
  modelResolves,
  planRetentionDescription,
} from "../../src/adapters/execution-safety.ts";
import type { SettingsFile } from "../../src/adapters/settings.ts";

/**
 * A settings object exactly as it sits on disk, before schema defaults apply.
 *
 * @remarks `SettingsFile` is the *output* of the loop's settings schema, where
 * `memory.enabled` carries `z.boolean().default(true)` and so reads as required.
 * These cases deliberately exercise the pre-default shape: `memory: {}` is what a
 * user actually writes, and `memoryState` separates it from `{ enabled: false }`
 * — only the latter is "off". Typing the fixtures as the schema's output would
 * erase the distinction under test, so the widening is named once, here.
 */
const onDisk = (settings: Record<string, unknown>): SettingsFile => settings as SettingsFile;

const OPENAI = { name: "openai", kind: "openai" } as const;

describe("execution safety", () => {
  it("explains the effective behavior", () => {
    const state = deriveRunControls(
      {
        providers: [OPENAI],
        default_model: "openai/model",
        memory: {} as SettingsFile["memory"],
      },
      "on",
    );
    expect(memoryDescription(state)).toBe(
      "Reads memory before the run and learns from it afterward.",
    );
  });

  it("explains memory and plan-retention consequences", () => {
    const controls = deriveRunControls({}, "off");
    expect(memoryDescription({ ...controls, memory: "inert" })).toContain("no extraction model");
    expect(memoryDescription({ ...controls, memory: "off" })).toContain(
      "Disabled for this session",
    );

    expect(planRetentionDescription("keep")).toEqual([
      "Completed plans remain available in the selected provider.",
    ]);
    expect(planRetentionDescription("discard")).toEqual([
      "Successful runs delete their plan after the result is recorded.",
      "Failed, cancelled or interrupted runs keep their plan.",
    ]);
  });
});

describe("memoryState — the one on/inert/off rule every surface shares", () => {
  it("is off without a block, with a disabled block, or when the session opted out", () => {
    expect(memoryState({})).toBe("off");
    expect(memoryState({ memory: { enabled: false }, providers: [OPENAI] })).toBe("off");
    expect(
      memoryState(
        onDisk({ memory: {}, default_model: "openai/model", providers: [OPENAI] }),
        "off",
      ),
    ).toBe("off");
  });

  it("is on only when the extraction model reaches a declared provider", () => {
    expect(
      memoryState(onDisk({ memory: {}, default_model: "openai/model", providers: [OPENAI] })),
    ).toBe("on");
    expect(
      memoryState(
        onDisk({
          memory: { model: "openai/mini" },
          default_model: "ghost/model",
          providers: [OPENAI],
        }),
      ),
    ).toBe("on");
  });

  it("settles the two formerly divergent inert cases the same way", () => {
    const undeclared = onDisk({ memory: {}, default_model: "ghost/model" });
    expect(memoryState(undeclared)).toBe("inert");
    const modelless = onDisk({ memory: {}, providers: [OPENAI] });
    expect(memoryState(modelless)).toBe("inert");
    expect(deriveRunControls(undeclared, "on").memory).toBe("inert");
    expect(deriveRunControls(modelless, "on").memory).toBe("inert");
  });

  it("modelResolves rejects unparsable tokens instead of throwing", () => {
    expect(modelResolves("not-a-model-ref", { providers: [OPENAI] })).toBe(false);
    expect(modelResolves(undefined, { providers: [OPENAI] })).toBe(false);
  });
});
