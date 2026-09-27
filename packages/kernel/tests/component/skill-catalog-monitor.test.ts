import { describe, expect, test } from "bun:test";
import { NOOP_LOGGER } from "@clarvis/capability";
import type { SkillContent } from "@clarvis/skills";
import {
  createSkillCatalogMonitor,
  type SkillPathWatcher,
} from "#src/extension-profiles/skill-catalog-monitor.ts";

function skill(name: string, source: string): SkillContent {
  const dir = `/catalog/${name}`;
  return {
    name,
    description: name,
    metadata: { name, description: name },
    userInvocable: true,
    scope: "workspace",
    source,
    root: "/catalog",
    dir,
    path: `${dir}/SKILL.md`,
    body: name,
    resources: [],
  };
}

function monitorFixture() {
  const callbacks = new Map<string, () => void>();
  const closed: string[] = [];
  const notices: string[] = [];
  let refreshes = 0;
  const watchSkillPath = (path: string, onChange: () => void): SkillPathWatcher => {
    callbacks.set(path, onChange);
    return { close: () => void closed.push(path) };
  };
  const monitor = createSkillCatalogMonitor({
    roots: [],
    logger: NOOP_LOGGER,
    watchSkillPath,
    onRefresh: () => {
      if (monitor.consumeRefresh()) refreshes++;
    },
    onPluginDrift: (notice) => notices.push(notice.name),
  });
  return { monitor, callbacks, closed, notices, refreshes: () => refreshes };
}

describe("skill catalog monitor", () => {
  test("plugin drift withdraws once while standalone edits coalesce", async () => {
    const fixture = monitorFixture();
    const plugin = skill("plugin-skill", "plugin:runner");
    const standalone = skill("standalone", "agents");
    fixture.monitor.observeCatalog([plugin, standalone]);
    const changePlugin = fixture.callbacks.get(plugin.path)!;
    changePlugin();
    changePlugin();
    expect(fixture.monitor.skillAvailable(plugin)).toBe(false);
    expect(fixture.notices).toEqual(["plugin-skill"]);
    expect(fixture.closed).toContain(plugin.path);
    const changeStandalone = fixture.callbacks.get(standalone.path)!;
    changeStandalone();
    changeStandalone();
    await Promise.resolve();
    expect(fixture.refreshes()).toBe(1);
    expect(fixture.notices).toEqual(["plugin-skill"]);
    fixture.monitor.close();
  });

  test("retired callbacks and repeated close cannot publish into another generation", async () => {
    const first = monitorFixture();
    const second = monitorFixture();
    const old = skill("old", "plugin:runner");
    first.monitor.observeCatalog([old]);
    const stale = first.callbacks.get(old.path)!;
    first.monitor.onRootsChanged(() => undefined);
    expect(first.monitor.publishRootsChanged()).toBe(true);
    stale();
    expect(first.monitor.skillAvailable(old)).toBe(true);
    expect(first.notices).toEqual([]);
    first.monitor.requestRefresh();
    first.monitor.close();
    first.monitor.close();
    stale();
    await Promise.resolve();
    expect(first.refreshes()).toBe(0);
    expect(second.refreshes()).toBe(0);
    expect(first.closed).toEqual([old.path]);
    second.monitor.close();
  });
});
