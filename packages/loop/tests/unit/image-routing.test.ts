import { describe, it, expect } from "../bun-test.ts";
import { validateDelegateTaskArgs } from "../../src/runtime/subagents/delegate-task.ts";
import {
  resolveSubagentProfiles,
  hasVisionCapableProfile,
} from "../../src/runtime/subagents/subagent-profiles.ts";
import {
  buildDelegateTaskTool,
  buildSpawnSubagentTool,
} from "../../src/runtime/subagents/lead-tools.ts";
import { collectTurnImages } from "../../src/runtime/subagents/build-subagent-input.ts";
import type { DelegateTaskAugmentation } from "@clarvis/capability";
import { loadEnv } from "@clarvis/capability";
import type { Message } from "@clarvis/capability";

/** A stand-in for a tracker's schema augmentation, exercising the same seam a
 * real `TaskTrackingPort` would use without depending on any particular tracker. */
const fakeTaskIdAugmentation: DelegateTaskAugmentation = {
  description: "Delegate one tracked task to a Sub-agent.",
  properties: {
    task_id: { type: "string", description: "The tracked task id to spawn against." },
  },
};

const env = loadEnv({});

const providers = [
  {
    name: "anthropic",
    kind: "anthropic" as const,
    models: {
      "vision-model": {
        context_window_tokens: 200000,
        capabilities: ["vision", "tool_calling"],
      },
      "blind-model": { context_window_tokens: 200000, capabilities: ["tool_calling"] },
    },
  },
];

const profiles = resolveSubagentProfiles(
  [
    { name: "coder", model: "anthropic/blind-model", tools: [], grants: ["read_workspace"] },
    {
      name: "vision_agent",
      model: "anthropic/vision-model",
      tools: [],
      grants: ["read_workspace"],
    },
  ],
  providers,
  env,
);

describe("collectTurnImages", () => {
  it("collects image parts across user messages in global order", () => {
    const msgs: Message[] = [
      { role: "system", content: "s" },
      {
        role: "user",
        content: [
          { type: "text", text: "a" },
          { type: "image", image: "img0" },
        ],
      },
      { role: "assistant", content: "ok" },
      { role: "user", content: "plain" },
      {
        role: "user",
        content: [
          { type: "image", image: "img1" },
          { type: "image", image: "img2" },
        ],
      },
    ];
    expect(collectTurnImages(msgs).map((i) => i.image)).toEqual(["img0", "img1", "img2"]);
  });

  it("returns empty when there are no images", () => {
    expect(collectTurnImages([{ role: "user", content: "hi" }])).toEqual([]);
  });
});

describe("hasVisionCapableProfile", () => {
  it("is true when some profile's model declares vision", () => {
    expect(hasVisionCapableProfile(profiles.values())).toBe(true);
  });

  it("is false when every profile's model lacks vision", () => {
    const only = resolveSubagentProfiles(
      [
        { name: "blind_helper", model: "anthropic/blind-model", tools: [] },
        { name: "blind_other", model: "anthropic/blind-model", tools: [] },
      ],
      providers,
      env,
    );
    expect(hasVisionCapableProfile(only.values())).toBe(false);
  });

  it("treats a model that declares no capabilities at all as blind", () => {
    const only = resolveSubagentProfiles(
      [{ name: "unknown_model", model: "anthropic/uncatalogued", tools: [] }],
      providers,
      env,
    );
    expect(hasVisionCapableProfile(only.values())).toBe(false);
  });

  it("is false for an empty registry", () => {
    expect(hasVisionCapableProfile([])).toBe(false);
  });
});

describe("validateDelegateTaskArgs — image_refs", () => {
  it("accepts image_refs for a vision profile and dedupes the indices", () => {
    const r = validateDelegateTaskArgs(
      { title: "w", task: "read", profile: "vision_agent", image_refs: [0, 0, 1] },
      {
        profiles,
        turnImageCount: 2,
      },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.image_refs).toEqual([0, 1]);
  });

  it("rejects image_refs for a profile whose model lacks vision", () => {
    const r = validateDelegateTaskArgs(
      { title: "w", task: "x", profile: "coder", image_refs: [0] },
      {
        profiles,
        turnImageCount: 1,
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("vision");
  });

  it("rejects an out-of-range index", () => {
    const r = validateDelegateTaskArgs(
      { title: "w", task: "x", profile: "vision_agent", image_refs: [3] },
      {
        profiles,
        turnImageCount: 2,
      },
    );
    expect(r.ok).toBe(false);
  });

  it("rejects image_refs when the turn carries no images", () => {
    const r = validateDelegateTaskArgs(
      { title: "w", task: "x", profile: "vision_agent", image_refs: [0] },
      {
        profiles,
        turnImageCount: 0,
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("no images");
  });

  it("rejects a non-array or empty image_refs", () => {
    expect(
      validateDelegateTaskArgs(
        { title: "w", task: "x", profile: "vision_agent", image_refs: [] },
        {
          profiles,
          turnImageCount: 2,
        },
      ).ok,
    ).toBe(false);
    expect(
      validateDelegateTaskArgs(
        { title: "w", task: "x", profile: "vision_agent", image_refs: "0" },
        {
          profiles,
          turnImageCount: 2,
        },
      ).ok,
    ).toBe(false);
  });

  it("omits image_refs from the result when it is not provided", () => {
    const r = validateDelegateTaskArgs(
      { title: "w", task: "x", profile: "vision_agent" },
      {
        profiles,
        turnImageCount: 2,
      },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.image_refs).toBeUndefined();
  });
});

describe("child-spawn tools — image_refs property gating", () => {
  const props = (t: ReturnType<typeof buildSpawnSubagentTool>): Record<string, unknown> =>
    (t.inputSchema as { properties: Record<string, unknown> }).properties;

  it("adds image_refs only when imageRefsAllowed is true", () => {
    expect(props(buildSpawnSubagentTool(profiles, true)).image_refs).toBeDefined();
    expect(props(buildSpawnSubagentTool(profiles, false)).image_refs).toBeUndefined();
  });

  it("adds image_refs alongside task_id when a tracker augments the schema", () => {
    const p = props(buildDelegateTaskTool(profiles, true, fakeTaskIdAugmentation));
    expect(p.image_refs).toBeDefined();
    expect(p.task_id).toBeDefined();
  });
});
