import { expect, test } from "bun:test";
import type { ExtensionProfileDefinition, ExtensionProfileService } from "@clarvis/protocol";
import { createContainerExtensionProfileService } from "../../src/config/container-extension-profile.ts";

const ref = { scope: "builtin", name: "container" } as const;
const authored = { scope: "global", name: "fixture" } as const;
const definition: ExtensionProfileDefinition = { schema_version: 1, plugins: [], skills: [] };

test("native preparation gets one stable builtin profile with zero extension inventory", async () => {
  const service = createContainerExtensionProfileService();
  const first = await service.current();
  expect(first.id).toBe("builtin:container");
  expect(first.immutable).toBe(true);
  expect(first.status).toBe("ready");
  expect(first.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
  expect(first).toEqual(await service.get(ref));
  expect(await service.list()).toEqual([{ ref, immutable: true, definition }]);
  expect(await service.inventory()).toEqual({ plugins: [], standalone_skills: [] });
  first.ref.name = "changed";
  first.definition?.plugins.push({ scope: "global", source: "clarvis", name: "forged" });
  first.counts.mcp_servers_active = 1;
  const next = await createContainerExtensionProfileService().current();
  expect(await service.current()).toEqual(next);
  expect(next.counts.mcp_servers_active).toBe(0);
  await expect(service.get({ scope: "builtin", name: "default" })).rejects.toMatchObject({
    code: "not_found",
  });
});

test("every selection, preview and mutation is unsupported with no alternate profile", async () => {
  const service = createContainerExtensionProfileService();
  const actions: Record<keyof ExtensionProfileService, (() => Promise<unknown>) | undefined> = {
    current: undefined,
    list: undefined,
    get: undefined,
    inventory: undefined,
    preview: () => service.preview(ref, { selection_scope: "global" }),
    previewClear: () => service.previewClear("global"),
    previewComposition: () =>
      service.previewComposition({
        ref: authored,
        definition: { schema_version: 1, plugins: [], skills: [] },
        expected_revision: null,
        selection_scope: "global",
      }),
    select: () => service.select(ref, { selection_scope: "global", preview_token: "fixture" }),
    clearSelection: () => service.clearSelection("global", { preview_token: "fixture" }),
    applyComposition: () =>
      service.applyComposition(
        {
          ref: authored,
          definition: { schema_version: 1, plugins: [], skills: [] },
          expected_revision: null,
          selection_scope: "global",
        },
        { preview_token: "fixture" },
      ),
    create: () =>
      service.create({ ref: authored, definition: { schema_version: 1, plugins: [], skills: [] } }),
    update: () =>
      service.update({
        ref: authored,
        definition: { schema_version: 1, plugins: [], skills: [] },
        expected_revision: "fixture",
      }),
    delete: () => service.delete(authored, { expected_revision: "fixture" }),
    clone: () => service.clone(ref, authored),
  };
  expect(Object.keys(actions).sort()).toEqual(Object.keys(service).sort());
  for (const action of Object.values(actions)) {
    if (action !== undefined) await expect(action()).rejects.toMatchObject({ code: "unsupported" });
  }
  expect((await service.current()).id).toBe("builtin:container");
});
