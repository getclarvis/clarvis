import { describe, expect, it } from "bun:test";
import {
  deriveIsolation,
  effectiveRunIsolation,
  deriveRunControls,
  memoryDescription,
  memoryState,
  modelResolves,
  planRetentionDescription,
  safetyDescription,
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
  it("shows active native configuration without replacing the idle next-run preference", () => {
    const host = {
      kind: "native",
      host_platform: "linux",
      isolation: "host",
      lifecycle: "ready",
    } as const;
    expect(effectiveRunIsolation("docker", host, true)).toBe("host");
    expect(effectiveRunIsolation("docker", host, false)).toBe("docker");
    expect(effectiveRunIsolation("docker", undefined, true)).toBe("docker");
    expect(
      effectiveRunIsolation(
        "docker",
        { ...host, isolation: "sandbox", lifecycle: "fallback" },
        false,
      ),
    ).toBe("sandbox");
  });
  it("derives isolation independently from command review", () => {
    expect(deriveIsolation({})).toBe("host");
    expect(deriveIsolation({ sandbox: { type: "native", enabled: true } })).toBe("sandbox");
    expect(deriveIsolation(onDisk({ runtime: { backend: "docker" } }))).toBe("docker");
    expect(
      deriveIsolation(
        onDisk({
          runtime: {
            backend: "podman",
            executable: "podman",
            image: "clarvis-runtime@sha256:" + "a".repeat(64),
            image_digest: "sha256:" + "a".repeat(64),
          },
        }),
      ),
    ).toBe("podman");
    expect(deriveRunControls({}, "auto", "off").isolation).toBe("host");
  });

  it("explains the effective behavior", () => {
    const state = deriveRunControls(
      {
        providers: [OPENAI],
        default_model: "openai/model",
        memory: {} as SettingsFile["memory"],
        sandbox: {
          type: "native",
          enabled: true,
          filesystem: "workspace-read-only",
          network: "none",
        },
      },
      "off",
      "on",
    );
    expect(safetyDescription(state)).toEqual([
      "Commands run autonomously inside the native sandbox.",
      "Shell commands see the workspace read-only.",
      "Shell network access is disabled.",
    ]);
    expect(memoryDescription(state)).toBe(
      "Reads memory before the run and learns from it afterward.",
    );
  });

  it("explains every guard, sandbox, memory, and plan-retention consequence", () => {
    const sandbox = {
      ...deriveRunControls(
        {
          sandbox: {
            type: "native" as const,
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
      "Commands use the native sandbox when available and may fall back to the host.",
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

    expect(planRetentionDescription("keep")).toEqual([
      "Completed plans remain available in the selected provider.",
    ]);
    expect(planRetentionDescription("discard")).toEqual([
      "Successful runs delete their plan after the result is recorded.",
      "Failed, cancelled or interrupted runs keep their plan.",
    ]);
  });

  it("describes container isolation without promising a hidden copy or merge", () => {
    expect(
      safetyDescription(
        deriveRunControls(onDisk({ runtime: { backend: "docker" } }), "off", "off"),
      ),
    ).toEqual([
      "Agent tools run inside a Linux Docker container.",
      "The selected workspace is mounted directly; changes appear on the host immediately.",
      "Outbound network access is enabled; guest services can be exposed to the host.",
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
    expect(deriveRunControls(undeclared, "off", "on").memory).toBe("inert");
    expect(deriveRunControls(modelless, "off", "on").memory).toBe("inert");
  });

  it("modelResolves rejects unparsable tokens instead of throwing", () => {
    expect(modelResolves("not-a-model-ref", { providers: [OPENAI] })).toBe(false);
    expect(modelResolves(undefined, { providers: [OPENAI] })).toBe(false);
  });
});
