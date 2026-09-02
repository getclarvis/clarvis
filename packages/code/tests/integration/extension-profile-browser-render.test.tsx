import { expect, test } from "bun:test";
import type {
  ExtensionProfileRef,
  ExtensionProfileService,
  ResolvedExtensionProfile,
} from "@clarvis/protocol";
import type { Interaction } from "../../src/keys/interaction.ts";
import { ExtensionProfileBrowser } from "../../src/views/config/ExtensionProfileBrowser.tsx";
import { createViewHost } from "../../src/views/config/view-host.tsx";
import { createFakeKeymap } from "../helpers/fake-keymap.ts";
import { openRender } from "../helpers/tracked-render.ts";

function resolved(ref: ExtensionProfileRef, current = false): ResolvedExtensionProfile {
  const research = ref.name === "research";
  return {
    id: `${ref.scope}:${ref.name}`,
    ref,
    immutable: ref.scope === "builtin",
    status: "ready",
    fingerprint: `sha256:${(research ? "b" : "a").repeat(64)}`,
    selection_origin: current ? "builtin" : ref.scope === "global" ? "global" : "workspace",
    ...(research
      ? {
          description: "Research with browser and documentation",
          definition_revision: `sha256:${"c".repeat(64)}`,
          definition: {
            schema_version: 1 as const,
            plugins: [{ scope: "global" as const, source: "clarvis" as const, name: "browser" }],
            skills: [],
          },
        }
      : {}),
    plugins: research
      ? [
          {
            ref: { scope: "global", source: "clarvis", name: "browser" },
            active: true,
            installed: true,
            valid: true,
            agents: [],
            skills: ["browse"],
            mcp_servers: ["browser:server"],
            hooks: { total: 1 },
            capability_executables: [],
          },
        ]
      : [],
    standalone_skills: [],
    issues: [],
    counts: {
      plugins_active: research ? 1 : 0,
      standalone_skills_active: 0,
      plugin_skills_active: research ? 1 : 0,
      mcp_servers_active: research ? 1 : 0,
      hooks_declared: research ? 1 : 0,
    },
  };
}

async function settle(
  rendered: Awaited<ReturnType<typeof openRender>>,
  predicate: () => boolean,
): Promise<void> {
  for (let index = 0; index < 60 && !predicate(); index += 1) {
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await rendered.renderOnce();
  }
}

test("renders diagnostics and previews the exact delta before selecting", async () => {
  const { keymap, press } = createFakeKeymap();
  const { host } = createViewHost({
    interaction: { keymap } as unknown as Interaction,
    close: () => {},
    dispatch: () => {},
  });
  const builtin = resolved({ scope: "builtin", name: "default" }, true);
  const research = resolved({ scope: "global", name: "research" });
  const previewed: string[] = [];
  const selected: string[] = [];
  const cleared: string[] = [];
  const deleted: string[] = [];
  const configured: string[] = [];
  const notifications: string[] = [];
  const service = {
    list: async () => [
      { ref: builtin.ref, immutable: true },
      {
        ref: research.ref,
        immutable: false,
        revision: research.definition_revision,
        definition: research.definition,
      },
    ],
    current: async () => builtin,
    get: async (ref) => (ref.name === "research" ? research : builtin),
    inventory: async () => ({
      plugins: Array.from({ length: 4 }, (_, index) => ({
        ref: {
          scope: "global" as const,
          source: "clarvis" as const,
          name: index === 0 ? "browser" : `plugin-${index}`,
        },
        active: false,
        installed: true,
        valid: true,
        agents: [],
        skills: index === 0 ? ["browse"] : [],
        mcp_servers: index === 0 ? ["browser:server"] : [],
        hooks: { total: index === 0 ? 1 : 0 },
        capability_executables: [],
      })),
      standalone_skills: [],
    }),
    preview: async (ref, options) => {
      previewed.push(`${ref.scope}:${ref.name}:${options.selection_scope}`);
      return {
        current: builtin,
        target: research,
        delta: {
          plugins_entering: [
            { scope: "global" as const, source: "clarvis" as const, name: "browser" },
          ],
          plugins_leaving: [],
          skills_entering: ["plugin:global:browser:browse"],
          skills_leaving: [],
          mcp_servers_entering: ["browser:server"],
          mcp_servers_leaving: [],
          hooks_entering: [
            {
              plugin: {
                scope: "global" as const,
                source: "clarvis" as const,
                name: "browser",
              },
              total: 1,
            },
          ],
          hooks_leaving: [],
        },
        token: "preview-token",
        requires_workspace_trust: false,
      };
    },
    previewClear: async () => ({
      current: research,
      target: builtin,
      delta: {
        plugins_entering: [],
        plugins_leaving: [
          { scope: "global" as const, source: "clarvis" as const, name: "browser" },
        ],
        skills_entering: [],
        skills_leaving: ["plugin:global:browser:browse"],
        mcp_servers_entering: [],
        mcp_servers_leaving: ["browser:server"],
        hooks_entering: [],
        hooks_leaving: [
          {
            plugin: {
              scope: "global" as const,
              source: "clarvis" as const,
              name: "browser",
            },
            total: 1,
          },
        ],
      },
      token: "clear-token",
      requires_workspace_trust: false,
    }),
    select: async (ref, options) => {
      selected.push(`${ref.scope}:${ref.name}:${options.selection_scope}:${options.preview_token}`);
      return { selected: ref, reconnect_required: true as const };
    },
    clearSelection: async (scope, options) => {
      cleared.push(`${scope}:${options.preview_token}`);
      return { selected: builtin.ref, reconnect_required: true as const };
    },
    previewComposition: async () => {
      throw new Error("not used");
    },
    applyComposition: async () => {
      throw new Error("not used");
    },
    create: async () => ({ ref: research.ref, immutable: false }),
    update: async () => ({ ref: research.ref, immutable: false }),
    delete: async (ref, options) => {
      deleted.push(`${ref.scope}:${ref.name}:${options.expected_revision}`);
    },
    clone: async () => ({ ref: research.ref, immutable: false }),
  } satisfies ExtensionProfileService;
  const rendered = await openRender(
    (() =>
      ExtensionProfileBrowser(host, {
        extensionProfiles: service,
        reconnect: async () => ({ ok: true, message: "ok" }),
        runActive: () => false,
        notify: (message) => notifications.push(message),
        configure: (ref) => configured.push(ref === undefined ? "new" : `${ref.scope}:${ref.name}`),
      })) as never,
    { width: 130, height: 30 },
  );
  await settle(rendered, () => rendered.captureCharFrame().includes("builtin:default"));
  press("down");
  await settle(rendered, () =>
    rendered.captureCharFrame().includes("Research with browser and documentation"),
  );

  const frame = rendered.captureCharFrame();
  expect(frame).toContain("global:research");
  expect(frame).toContain("1/4 plugins");
  press("return");
  await rendered.renderOnce();
  expect(rendered.captureCharFrame()).toContain("browser:server");
  press("escape");
  await rendered.renderOnce();
  press("e");
  expect(configured).toEqual(["global:research"]);

  press("w");
  await settle(rendered, () => rendered.captureCharFrame().includes("Review before selecting"));
  expect(previewed).toEqual(["global:research:workspace"]);
  expect(host.pendingConfirm()).toBeNull();
  expect(rendered.captureCharFrame()).toContain("global/clarvis/browser");
  expect(rendered.captureCharFrame()).toContain("[y] apply and reconnect");
  expect(rendered.captureCharFrame()).toContain("[n] keep current");
  expect(selected).toEqual([]);
  press("y");
  await settle(rendered, () => selected.length === 1);
  expect(selected).toEqual(["global:research:workspace:preview-token"]);
  await settle(rendered, () => notifications.length === 1);

  press("x");
  await rendered.renderOnce();
  press("return");
  await settle(rendered, () => rendered.captureCharFrame().includes("Review before clearing"));
  expect(rendered.captureCharFrame()).toContain("Plugins leaving (1)");
  expect(cleared).toEqual([]);
  press("y");
  await settle(rendered, () => cleared.length === 1);
  expect(cleared).toEqual(["workspace:clear-token"]);
  await settle(rendered, () => notifications.length === 2);

  press("x");
  await rendered.renderOnce();
  press("down");
  press("return");
  await settle(rendered, () =>
    rendered.captureCharFrame().includes("clearing the global selection"),
  );
  press("y");
  await settle(rendered, () => cleared.length === 2);
  expect(cleared).toEqual(["workspace:clear-token", "global:clear-token"]);
  rendered.renderer.destroy();
});

test("a long Extension Profile delta scrolls while decisions remain visible at 80x24", async () => {
  const { keymap, press } = createFakeKeymap();
  const { host } = createViewHost({
    interaction: { keymap } as unknown as Interaction,
    close: () => {},
    dispatch: () => {},
  });
  const builtin = resolved({ scope: "builtin", name: "default" }, true);
  const research = resolved({ scope: "global", name: "research" });
  const plugins = Array.from({ length: 18 }, (_, index) => ({
    scope: "global" as const,
    source: "agents" as const,
    name: `plugin-${String(index).padStart(2, "0")}`,
  }));
  const service = {
    list: async () => [
      { ref: builtin.ref, immutable: true },
      { ref: research.ref, immutable: false, definition: research.definition },
    ],
    current: async () => builtin,
    get: async (ref) => (ref.name === "research" ? research : builtin),
    inventory: async () => ({ plugins: [], standalone_skills: [] }),
    preview: async () => ({
      current: builtin,
      target: research,
      delta: {
        plugins_entering: plugins,
        plugins_leaving: [],
        skills_entering: Array.from({ length: 18 }, (_, index) => `skill-${index}`),
        skills_leaving: [],
        mcp_servers_entering: ["context7", "browser"],
        mcp_servers_leaving: [],
        hooks_entering: [{ plugin: plugins[17]!, total: 4 }],
        hooks_leaving: [],
      },
      token: "long-preview",
      requires_workspace_trust: true,
    }),
    previewClear: async () => {
      throw new Error("not used");
    },
    select: async () => ({ selected: research.ref, reconnect_required: true as const }),
    clearSelection: async () => ({ selected: builtin.ref, reconnect_required: true as const }),
    previewComposition: async () => {
      throw new Error("not used");
    },
    applyComposition: async () => {
      throw new Error("not used");
    },
    create: async () => ({ ref: research.ref, immutable: false }),
    update: async () => ({ ref: research.ref, immutable: false }),
    delete: async () => {},
    clone: async () => ({ ref: research.ref, immutable: false }),
  } satisfies ExtensionProfileService;
  const rendered = await openRender(
    (() =>
      ExtensionProfileBrowser(host, {
        extensionProfiles: service,
        reconnect: async () => ({ ok: true, message: "ok" }),
        runActive: () => false,
        notify: () => {},
        configure: () => {},
      })) as never,
    { width: 80, height: 24 },
  );
  await settle(rendered, () => rendered.captureCharFrame().includes("global:research"));
  press("down");
  press("w");
  await settle(rendered, () => rendered.captureCharFrame().includes("Review before selecting"));
  let frame = rendered.captureCharFrame();
  expect(frame).toContain("y applies and reconnects");
  expect(frame).toContain("[y] apply and reconnect");
  expect(frame).toContain("[n] keep current");

  for (let index = 0; index < 8; index += 1) press("pagedown");
  await rendered.renderOnce();
  frame = rendered.captureCharFrame();
  expect(frame).toContain("Workspace trust");
  expect(frame).toContain("Global installed plugins need no additional approval");
  expect(frame).toContain("[y] apply and reconnect");
  expect(frame).toContain("[n] keep current");
  rendered.renderer.destroy();
});

test("deletes an inactive custom Extension Profile only after revision-bound confirmation", async () => {
  const { keymap, press } = createFakeKeymap();
  const { host } = createViewHost({
    interaction: { keymap } as unknown as Interaction,
    close: () => {},
    dispatch: () => {},
  });
  const builtin = resolved({ scope: "builtin", name: "default" }, true);
  const research = resolved({ scope: "global", name: "research" });
  const deleted: string[] = [];
  const service = {
    list: async () => [
      { ref: builtin.ref, immutable: true },
      {
        ref: research.ref,
        immutable: false,
        revision: research.definition_revision,
        definition: research.definition,
      },
    ],
    current: async () => builtin,
    get: async (ref) => (ref.name === "research" ? research : builtin),
    inventory: async () => ({ plugins: [], standalone_skills: [] }),
    preview: async () => {
      throw new Error("not used");
    },
    previewClear: async () => {
      throw new Error("not used");
    },
    previewComposition: async () => {
      throw new Error("not used");
    },
    select: async () => {
      throw new Error("not used");
    },
    clearSelection: async () => {
      throw new Error("not used");
    },
    applyComposition: async () => {
      throw new Error("not used");
    },
    create: async () => {
      throw new Error("not used");
    },
    update: async () => {
      throw new Error("not used");
    },
    delete: async (ref, options) => {
      deleted.push(`${ref.scope}:${ref.name}:${options.expected_revision}`);
    },
    clone: async () => {
      throw new Error("not used");
    },
  } satisfies ExtensionProfileService;
  const rendered = await openRender(
    (() =>
      ExtensionProfileBrowser(host, {
        extensionProfiles: service,
        reconnect: async () => ({ ok: true, message: "ok" }),
        runActive: () => false,
        notify: () => {},
        configure: () => {},
      })) as never,
    { width: 100, height: 26 },
  );
  await settle(rendered, () => {
    const frame = rendered.captureCharFrame();
    return frame.includes("global:research") && !frame.includes("Loading Extension Profiles");
  });
  press("down");
  press("d");
  await rendered.renderOnce();
  expect(rendered.captureCharFrame()).toContain("Delete global:research?");
  expect(deleted).toEqual([]);
  press("y");
  await settle(rendered, () => deleted.length === 1);
  expect(deleted).toEqual([`global:research:${research.definition_revision}`]);
  rendered.renderer.destroy();
});

test("keeps Extension Profile load failures visible until a successful retry", async () => {
  const { keymap, press } = createFakeKeymap();
  const { host } = createViewHost({
    interaction: { keymap } as unknown as Interaction,
    close: () => {},
    dispatch: () => {},
  });
  const builtin = resolved({ scope: "builtin", name: "default" }, true);
  const notifications: string[] = [];
  let attempts = 0;
  const service = {
    list: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("ENOENT: no such file or directory, scandir '/tmp/extension-profiles'");
      }
      return [{ ref: builtin.ref, immutable: true }];
    },
    current: async () => builtin,
    get: async () => builtin,
    inventory: async () => ({ plugins: [], standalone_skills: [] }),
    preview: async () => {
      throw new Error("not used");
    },
    previewClear: async () => {
      throw new Error("not used");
    },
    select: async () => {
      throw new Error("not used");
    },
    clearSelection: async () => {
      throw new Error("not used");
    },
    previewComposition: async () => {
      throw new Error("not used");
    },
    applyComposition: async () => {
      throw new Error("not used");
    },
    create: async () => {
      throw new Error("not used");
    },
    update: async () => {
      throw new Error("not used");
    },
    delete: async () => {
      throw new Error("not used");
    },
    clone: async () => {
      throw new Error("not used");
    },
  } satisfies ExtensionProfileService;
  const rendered = await openRender(
    (() =>
      ExtensionProfileBrowser(host, {
        extensionProfiles: service,
        reconnect: async () => ({ ok: true, message: "ok" }),
        runActive: () => false,
        notify: (message) => notifications.push(message),
        configure: () => {},
      })) as never,
    { width: 80, height: 24 },
  );

  await settle(rendered, () =>
    rendered.captureCharFrame().includes("Extension Profile catalog unavailable"),
  );
  for (let index = 0; index < 5; index += 1) await rendered.renderOnce();
  let frame = rendered.captureCharFrame();
  expect(frame).toContain("Extension Profile catalog unavailable");
  expect(frame).toContain("r retries");
  expect(frame).toContain("ENOENT");
  expect(notifications).toEqual([
    "ENOENT: no such file or directory, scandir '/tmp/extension-profiles'",
  ]);

  press("r");
  await settle(rendered, () => rendered.captureCharFrame().includes("builtin:default"));
  frame = rendered.captureCharFrame();
  expect(attempts).toBe(2);
  expect(frame).toContain("builtin:default");
  expect(frame).not.toContain("Extension Profile catalog unavailable");
  rendered.renderer.destroy();
});
