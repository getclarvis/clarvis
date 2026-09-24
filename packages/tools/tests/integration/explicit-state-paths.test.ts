import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ensureWorkspaceLocalDir, workspaceStatePaths } from "@clarvis/paths";
import { resolveConfig, StartupError } from "../../src/config.ts";
import { readableStateArtifactPath } from "../../src/lib/state-artifacts.ts";
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

  it("pins selected spills while Host access to another tree follows OS permissions", async () => {
    const selected = paths("selected");
    const sibling = paths("sibling");
    ensureWorkspaceLocalDir(selected);
    ensureWorkspaceLocalDir(sibling);
    const own = selected.toolOutputSpill("12345678");
    const other = sibling.toolOutputSpill("12345678");
    writeFileSync(own, "selected result");
    writeFileSync(other, "sibling result");
    const control = join(selected.localDir, "monitor-old.json");
    writeFileSync(control, "private control record");
    const config = resolveConfig({
      workspaceRoot: workspace,
      statePaths: selected,
      probeRipgrep: () => false,
    });
    const admitted = await callTool("read_file", { path: own }, config);
    expect(admitted.isError).toBe(false);
    expect(admitted.text).toContain("selected result");
    const siblingRead = await callTool("read_file", { path: other }, config);
    expect(siblingRead.isError).toBe(false);
    expect(siblingRead.text).toContain("sibling result");
    expect(readableStateArtifactPath(own, config.stateRoot)).toBe(own);
    expect(readableStateArtifactPath(other, config.stateRoot)).toBeUndefined();
    expect(readableStateArtifactPath(control, config.stateRoot)).toBeUndefined();
    expect(readableStateArtifactPath(selected.localDir, config.stateRoot)).toBeUndefined();
  });

  it("does not adopt persisted monitor controls from either namespace", async () => {
    const selected = paths("selected");
    const sibling = paths("sibling");
    const id = "ses_12345678";
    for (const state of [selected, sibling]) {
      ensureWorkspaceLocalDir(state);
      writeFileSync(join(state.localDir, "monitor-old.json"), "private control record");
    }
    const config = resolveConfig({
      workspaceRoot: workspace,
      statePaths: selected,
      probeRipgrep: () => false,
    });
    const listed = await callTool("shell_session", { action: "list" }, config);
    expect(listed.isError).toBe(false);
    expect(listed.text).toBe('{"sessions":[]}');
    const polled = await callTool("shell_session", { action: "poll", session_id: id }, config);
    expect(polled.isError).toBe(true);
    expect(polled.text).toContain("not_found");
    expect(existsSync(join(selected.localDir, "monitor-old.json"))).toBe(true);
    expect(existsSync(join(sibling.localDir, "monitor-old.json"))).toBe(true);
  });
});
