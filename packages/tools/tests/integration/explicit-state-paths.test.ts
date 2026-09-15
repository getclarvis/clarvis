import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync, utimesSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ensureWorkspaceLocalDir, workspaceStatePaths } from "@clarvis/paths";
import { resolveConfig, StartupError } from "../../src/config.ts";
import { readableStateArtifactPath } from "../../src/lib/state-artifacts.ts";
import {
  exitPath,
  logPath,
  sidecarPath,
  sweepMonitors,
  writeSidecar,
} from "../../src/lib/monitor.ts";
import { callTool, cleanup, makeWorkspace } from "../helpers/fixtures.ts";

describe("explicit machinery namespace", () => {
  let root: string;
  let workspace: string;
  beforeEach(() => {
    root = makeWorkspace();
    workspace = join(root, "workspace");
    mkdirSync(workspace);
  });
  afterEach(() => cleanup(root));

  function paths(name: string) {
    return workspaceStatePaths(workspace, { env: { CLARVIS_HOME: join(root, name) } });
  }

  it("binds a defensive snapshot and refuses another workspace", () => {
    const selected = paths("selected");
    const config = resolveConfig({
      workspaceRoot: workspace,
      statePaths: selected,
      probeRipgrep: () => false,
    });
    expect(config.stateRoot).toBe(selected.root);
    expect(config.statePaths).not.toBe(selected);
    expect(Object.isFrozen(config.statePaths)).toBe(true);
    expect(() =>
      resolveConfig({
        workspaceRoot: workspace,
        statePaths: workspaceStatePaths(root),
        probeRipgrep: () => false,
      }),
    ).toThrow(StartupError);
  });

  it("reads selected namespace spills and preserves the narrower guard artifact exception", async () => {
    const selected = paths("selected");
    const sibling = paths("sibling");
    ensureWorkspaceLocalDir(selected);
    ensureWorkspaceLocalDir(sibling);
    const own = selected.toolOutputSpill("12345678");
    const other = sibling.toolOutputSpill("12345678");
    writeFileSync(own, "selected result");
    writeFileSync(other, "sibling result");
    const control = sidecarPath(selected, "mon_12345678");
    writeFileSync(control, "private control record");
    const config = resolveConfig({
      workspaceRoot: workspace,
      statePaths: selected,
      probeRipgrep: () => false,
    });
    const admitted = await callTool("read_file", { path: own }, config);
    expect(admitted.isError).toBe(false);
    expect(admitted.text).toContain("selected result");
    expect((await callTool("read_file", { path: other }, config)).isError).toBe(true);
    expect(readableStateArtifactPath(own, config.stateRoot)).toBe(own);
    expect(readableStateArtifactPath(other, config.stateRoot)).toBeUndefined();
    expect(readableStateArtifactPath(control, config.stateRoot)).toBeUndefined();
    expect(readableStateArtifactPath(selected.localDir, config.stateRoot)).toBeUndefined();
  });

  it("lists, polls and sweeps monitors in the same explicit namespace", async () => {
    const selected = paths("selected");
    const sibling = paths("sibling");
    const id = "mon_12345678";
    for (const state of [selected, sibling]) {
      ensureWorkspaceLocalDir(state);
      await writeSidecar(state, {
        id,
        command: "fixture",
        cwd: workspace,
        pid: 2147483647,
        startedAt: Date.now(),
        readyWhen: null,
      });
      writeFileSync(logPath(state, id), state === selected ? "selected log" : "sibling log");
      writeFileSync(exitPath(state, id), "0");
      const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
      utimesSync(exitPath(state, id), old, old);
    }
    const config = resolveConfig({
      workspaceRoot: workspace,
      statePaths: selected,
      probeRipgrep: () => false,
    });
    const listed = await callTool("monitor_list", {}, config);
    expect(listed.isError).toBe(false);
    expect(listed.text).toContain(id);
    const polled = await callTool("monitor_poll", { id, offset: 0 }, config);
    expect(polled.isError).toBe(false);
    expect(polled.text).toContain("selected log");
    expect(polled.text).not.toContain("sibling log");
    await sweepMonitors(selected);
    expect(existsSync(sidecarPath(selected, id))).toBe(false);
    expect(existsSync(logPath(selected, id))).toBe(false);
    expect(existsSync(exitPath(selected, id))).toBe(false);
    expect(existsSync(sidecarPath(sibling, id))).toBe(true);
    expect(existsSync(logPath(sibling, id))).toBe(true);
    expect(existsSync(exitPath(sibling, id))).toBe(true);
  });
});
