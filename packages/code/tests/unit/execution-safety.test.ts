import { describe, expect, it } from "bun:test";
import { memoryState, modelResolves } from "../../src/adapters/execution-safety.ts";
import type { SettingsFile } from "../../src/adapters/settings.ts";

/**
 * A settings object exactly as it sits on disk, before schema defaults apply.
 *
 * @remarks `SettingsFile` is the *output* of the loop's settings schema, where
 * `memory.enabled` carries `z.boolean().default(true)` and so reads as required.
 * These cases deliberately exercise the pre-default shape of settings files.
 */
const onDisk = (settings: Record<string, unknown>): SettingsFile => settings as SettingsFile;

const OPENAI = { name: "openai", kind: "openai" } as const;

describe("memoryState — the one on/inert/off rule every surface shares", () => {
  it("is off by default or when the global choice is off", () => {
    expect(memoryState({})).toBe("off");
    expect(
      memoryState(
        onDisk({ memory: { enabled: false }, default_model: "openai/model", providers: [OPENAI] }),
        "on",
      ),
    ).toBe("on");
    expect(
      memoryState(
        onDisk({ memory: {}, default_model: "openai/model", providers: [OPENAI] }),
        "off",
      ),
    ).toBe("off");
  });

  it("is on only when the selected run model reaches a declared provider", () => {
    expect(memoryState(onDisk({ default_model: "openai/model", providers: [OPENAI] }), "on")).toBe(
      "on",
    );
    expect(
      memoryState(
        onDisk({
          default_model: "ghost/model",
          providers: [OPENAI],
        }),
        "on",
        "openai/mini",
      ),
    ).toBe("on");
  });

  it("settles the two formerly divergent inert cases the same way", () => {
    const undeclared = onDisk({ memory: {}, default_model: "ghost/model" });
    expect(memoryState(undeclared, "on")).toBe("inert");
    const modelless = onDisk({ memory: {}, providers: [OPENAI] });
    expect(memoryState(modelless, "on")).toBe("inert");
  });

  it("modelResolves rejects unparsable tokens instead of throwing", () => {
    expect(modelResolves("not-a-model-ref", { providers: [OPENAI] })).toBe(false);
    expect(modelResolves(undefined, { providers: [OPENAI] })).toBe(false);
  });
});
