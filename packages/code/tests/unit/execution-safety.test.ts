import { describe, expect, it } from "bun:test";
import {
  deriveRunControls,
  memoryDescription,
  memoryState,
  modelResolves,
  plansDescription,
  safetyDescription,
  settingsForPreset,
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
  it.each([
    ["free", {}, "off"],
    ["judged", {}, "auto"],
    ["approval", {}, "on"],
    [
      "isolated",
      { sandbox: { type: "bubblewrap", enabled: true, availability: "required" } },
      "off",
    ],
    [
      "reviewed",
      { sandbox: { type: "bubblewrap", enabled: true, availability: "required" } },
      "auto",
    ],
    [
      "protected",
      { sandbox: { type: "bubblewrap", enabled: true, availability: "required" } },
      "on",
    ],
  ] as const)("derives %s", (preset, settings, guard) => {
    expect(deriveRunControls(settings, guard, "off").preset).toBe(preset);
  });

  it("derives custom for a restricted sandbox", () => {
    expect(
      deriveRunControls(
        {
          sandbox: {
            type: "bubblewrap",
            enabled: true,
            filesystem: "workspace-read-only",
            network: "none",
          },
        },
        "off",
        "off",
      ).preset,
    ).toBe("custom");
  });

  it("maps every preset to explicit guard and sandbox settings", () => {
    expect(settingsForPreset("free").sandbox?.enabled).toBe(false);
    expect(settingsForPreset("judged")).toMatchObject({
      guard: { mode: "auto" },
      sandbox: { enabled: false },
    });
    expect(settingsForPreset("approval").guard?.mode).toBe("on");
    expect(settingsForPreset("isolated").sandbox?.enabled).toBe(true);
    expect(settingsForPreset("reviewed").guard?.mode).toBe("auto");
    expect(settingsForPreset("protected").guard?.mode).toBe("on");
  });

  it("explains the effective behavior", () => {
    const state = deriveRunControls(
      {
        providers: [OPENAI],
        default_model: "openai/model",
        memory: {} as SettingsFile["memory"],
        sandbox: {
          type: "bubblewrap",
          enabled: true,
          filesystem: "workspace-read-only",
          network: "none",
        },
      },
      "off",
      "on",
    );
    expect(safetyDescription(state)).toEqual([
      "Commands run autonomously inside Bubblewrap.",
      "Shell commands see the workspace read-only.",
      "Shell network access is disabled.",
    ]);
    expect(memoryDescription(state)).toBe(
      "Reads memory before the run and learns from it afterward.",
    );
  });

  it("explains every guard, sandbox, memory, and plan-policy consequence", () => {
    const sandbox = {
      ...deriveRunControls(
        {
          sandbox: {
            type: "bubblewrap" as const,
            enabled: true,
            availability: "optional" as const,
            filesystem: "workspace-write" as const,
            network: "host" as const,
          },
        },
        "auto" as const,
        "off" as const,
      ),
    };
    expect(safetyDescription(sandbox)).toEqual([
      "Commands use Bubblewrap when available and may fall back to the host.",
      "Shell commands may change this workspace.",
      "Host network access is enabled.",
    ]);

    expect(safetyDescription(deriveRunControls({}, "off", "off"))).toEqual([
      "Commands run directly without approval.",
    ]);
    expect(safetyDescription(deriveRunControls({}, "on", "off"))).toEqual([
      "Risky actions ask before running directly on the host.",
    ]);
    expect(safetyDescription(deriveRunControls({}, "auto", "off"))).toEqual([
      "Commands run directly on the host after model review; uncertain actions ask you.",
    ]);
    expect(memoryDescription({ ...sandbox, memory: "inert" })).toContain("no extraction model");
    expect(memoryDescription({ ...sandbox, memory: "off" })).toContain("Disabled for this session");

    expect(
      plansDescription({
        ...sandbox,
        plans: { mode: "off", history: "keep", configured: true },
      }),
    ).toEqual(["The lead gets no plan tools and works without a written plan."]);
    expect(
      plansDescription({
        ...sandbox,
        plans: { mode: "review", history: "keep", configured: true },
      }),
    ).toEqual([
      expect.stringContaining("waits for your approval"),
      expect.stringContaining("stay available"),
    ]);
    expect(
      plansDescription({
        ...sandbox,
        plans: { mode: "on", history: "discard", configured: true },
      }),
    ).toEqual([expect.stringContaining("without waiting"), expect.stringContaining("deleted")]);
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
    expect(deriveRunControls(undeclared, "off", "on").memory).toBe("inert");
    expect(deriveRunControls(modelless, "off", "on").memory).toBe("inert");
  });

  it("modelResolves rejects unparsable tokens instead of throwing", () => {
    expect(modelResolves("not-a-model-ref", { providers: [OPENAI] })).toBe(false);
    expect(modelResolves(undefined, { providers: [OPENAI] })).toBe(false);
  });
});
