import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  BubblewrapBackend,
  createExecutionPolicy,
  prepareLaunch,
  SeatbeltBackend,
} from "../../../src/index.ts";

test.skipIf(!["linux", "darwin"].includes(process.platform))(
  "native explicit write grants preserve scratch confinement and mandatory read-only paths",
  () => {
    const root = realpathSync(mkdtempSync("/tmp/clarvis-scoped-writes-"));
    const workspace = join(root, "workspace");
    const scratch = join(root, "scratch");
    const alias = join(root, "workspace-alias");
    for (const path of [workspace, scratch]) mkdirSync(path);
    symlinkSync(workspace, alias);
    const target = join(workspace, "target");
    const protectedPath = join(workspace, "protected");
    const unrelated = join(root, "unrelated");
    for (const path of [target, protectedPath, unrelated]) writeFileSync(path, "original");
    const backend = process.platform === "darwin" ? new SeatbeltBackend() : new BubblewrapBackend();
    const run = (command: string, additionalWriteRoots: string[] = []) => {
      const policy = createExecutionPolicy({
        id: "scoped",
        mode: "sandbox",
        workspaceRoot: workspace,
        homeRoot: root,
        workspaceAccess: "read-only",
        sharedTemporaryWrites: false,
        temporaryWriteRoots: [scratch],
        additionalWriteRoots,
        readOnlyPaths: [protectedPath],
      });
      const launch = prepareLaunch(
        policy,
        {
          file: "/bin/sh",
          args: ["-c", command],
          cwd: workspace,
          env: { PATH: "/usr/bin:/bin" },
        },
        backend,
      );
      return spawnSync(launch.file, [...launch.args], {
        cwd: launch.cwd,
        env: launch.env,
        encoding: "utf8",
        timeout: 5000,
      });
    };
    try {
      expect(run(`printf scratch > '${join(scratch, "probe")}'`).status).toBe(0);
      expect(readFileSync(join(scratch, "probe"), "utf8")).toBe("scratch");
      expect(run(`printf changed > '${unrelated}'`).status).not.toBe(0);
      expect(readFileSync(unrelated, "utf8")).toBe("original");
      expect(run("printf changed > target").status).not.toBe(0);
      for (const grant of [workspace, alias]) {
        const result = run("printf approved > target", [grant]);
        expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
        expect(readFileSync(target, "utf8")).toBe("approved");
        expect(run("printf changed > protected", [grant]).status).not.toBe(0);
        expect(readFileSync(protectedPath, "utf8")).toBe("original");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
