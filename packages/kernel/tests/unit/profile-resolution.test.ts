import { describe, expect, test } from "bun:test";
import {
  prepareProfileResolution,
  resolveProfileData,
  type ResolutionSkill,
} from "#src/extension-profiles/profile-resolution.ts";
import type { ExtensionProfilePluginRef, WorkspaceTrustVerdict } from "@clarvis/protocol";

const TRUSTED: WorkspaceTrustVerdict = {
  state: "trusted",
  fingerprint: `sha256:${"1".repeat(64)}`,
};
const plugin = (scope: "global" | "workspace", name: string): ExtensionProfilePluginRef => ({
  scope,
  source: "agents",
  name,
});

describe("pure Extension Profile resolution", () => {
  test("builtin skill precedence and fingerprint are stable for collected inputs", () => {
    const discovered: ResolutionSkill[] = [
      {
        ref: { scope: "user", source: "agents", name: "review" },
        rootOrder: 0,
        description: "user",
      },
      {
        ref: { scope: "workspace", source: "agents", name: "review" },
        rootOrder: 1,
        description: "workspace",
      },
    ];
    const prepared = prepareProfileResolution({
      selection: { ref: { scope: "builtin", name: "default" }, origin: "builtin" },
      enabledPlugins: [],
      workspaceTrust: TRUSTED,
      assumeWorkspaceTrusted: false,
      discovered,
    });
    expect(prepared.selectedSkills).toEqual([discovered[1]!.ref]);
    const input = {
      prepared,
      contributionSnapshots: [],
      installedPlugins: [],
      capturedSkills: [{ ...discovered[1]!, digest: "sha256:skill" }],
    };
    const first = resolveProfileData(input);
    const second = resolveProfileData(input);
    expect(first).toEqual(second);
    expect(first.status).toBe("ready");
    expect(first.standalone_skills).toMatchObject([{ active: true, digest: "sha256:skill" }]);
    expect(first.fingerprint).toBe(
      "sha256:ad8918e8c9ba91b47d5ff7653d9d2fbd27e6ba5b2b1e11df37dc6864170f1d68",
    );
  });

  test("exact references, invalid definition and trust restrictions fail closed", () => {
    const selected = plugin("workspace", "runner");
    const prepared = prepareProfileResolution({
      selection: { ref: { scope: "workspace", name: "work" }, origin: "workspace" },
      definitionView: {
        ref: { scope: "workspace", name: "work" },
        immutable: false,
        revision: `sha256:${"2".repeat(64)}`,
        definition: { schema_version: 1, plugins: [selected], skills: [] },
      },
      enabledPlugins: [],
      workspaceTrust: { state: "unapproved" },
      assumeWorkspaceTrusted: false,
      discovered: [],
    });
    expect(prepared.admittedPlugins).toEqual([]);
    const result = resolveProfileData({
      prepared,
      contributionSnapshots: [],
      installedPlugins: [],
      capturedSkills: [],
    });
    expect(result.status).toBe("degraded");
    expect(result.plugins).toMatchObject([{ ref: selected, active: false, installed: false }]);
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "workspace_untrusted",
      "missing_plugin",
    ]);

    const invalid = prepareProfileResolution({
      selection: { ref: { scope: "global", name: "broken" }, origin: "global" },
      definitionView: {
        ref: { scope: "global", name: "broken" },
        immutable: false,
        error: "invalid",
      },
      enabledPlugins: [plugin("global", "ignored")],
      workspaceTrust: TRUSTED,
      assumeWorkspaceTrusted: false,
      discovered: [],
    });
    expect(
      resolveProfileData({
        prepared: invalid,
        contributionSnapshots: [],
        installedPlugins: [],
        capturedSkills: [],
      }),
    ).toMatchObject({
      status: "invalid",
      plugins: [],
    });
  });
});
