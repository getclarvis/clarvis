import { expect, test } from "bun:test";
import type { EnvironmentRef, EnvironmentService, ResolvedEnvironment } from "@clarvis/protocol";
import type { Interaction } from "../../src/keys/interaction.ts";
import { EnvironmentBrowser } from "../../src/views/config/EnvironmentBrowser.tsx";
import { createViewHost } from "../../src/views/config/view-host.tsx";
import { createFakeKeymap } from "../helpers/fake-keymap.ts";
import { openRender } from "../helpers/tracked-render.ts";

function resolved(ref: EnvironmentRef, current = false): ResolvedEnvironment {
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
            hooks: { total: 1, approved: 1 },
            capability_executables: [],
          },
        ]
      : [],
    standalone_skills: [],
    issues: [],
    counts: {
      plugins_active: research ? 1 : 0,
      plugins_installed: 4,
      standalone_skills_active: 0,
      standalone_skills_discovered: 12,
      plugin_skills_active: research ? 1 : 0,
      plugin_skills_discovered: 3,
      mcp_servers_active: research ? 1 : 0,
      hooks_declared: research ? 1 : 0,
      hooks_approved: research ? 1 : 0,
    },
  };
}

async function settle(
  rendered: Awaited<ReturnType<typeof openRender>>,
  predicate: () => boolean,
): Promise<void> {
  for (let index = 0; index < 30 && !predicate(); index += 1) {
    await Promise.resolve();
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
              approved: 1,
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
            approved: 1,
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
    create: async () => ({ ref: research.ref, immutable: false }),
    update: async () => ({ ref: research.ref, immutable: false }),
    clone: async () => ({ ref: research.ref, immutable: false }),
  } satisfies EnvironmentService;
  const rendered = await openRender(
    (() =>
      EnvironmentBrowser(host, {
        environments: service,
        reconnect: async () => ({ ok: true, message: "ok" }),
        runActive: () => false,
        notify: () => {},
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
  expect(frame).toContain("1 active / 4 installed");
  expect(frame).toContain("browser:server");

  press("w");
  await settle(rendered, () => host.pendingConfirm() !== null);
  expect(previewed).toEqual(["global:research:workspace"]);
  expect(host.pendingConfirm()?.detail).toEqual(
    expect.arrayContaining([
      "plugins entering: global/clarvis/browser",
      "MCP servers entering: browser:server",
      "hooks entering: 1",
    ]),
  );
  expect(selected).toEqual([]);
  press("y");
  await settle(rendered, () => selected.length === 1);
  expect(selected).toEqual(["global:research:workspace:preview-token"]);
  await settle(rendered, () => false);

  press("x");
  await settle(rendered, () => host.pendingConfirm() !== null);
  expect(host.pendingConfirm()?.detail).toEqual(
    expect.arrayContaining([
      "plugins leaving: global/clarvis/browser",
      "MCP servers leaving: browser:server",
      "hooks leaving: 1",
    ]),
  );
  expect(cleared).toEqual([]);
  press("y");
  await settle(rendered, () => cleared.length === 1);
  expect(cleared).toEqual(["workspace:clear-token"]);
  await settle(rendered, () => false);

  press("d");
  await settle(rendered, () => host.pendingConfirm() !== null);
  expect(host.pendingConfirm()?.message).toContain("global default");
  press("y");
  await settle(rendered, () => cleared.length === 2);
  expect(cleared).toEqual(["workspace:clear-token", "global:clear-token"]);
  rendered.renderer.destroy();
});
