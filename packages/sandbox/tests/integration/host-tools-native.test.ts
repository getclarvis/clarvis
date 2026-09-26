import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  BubblewrapBackend,
  createExecutionPolicy,
  prepareLaunch,
  SeatbeltBackend,
} from "../../src/index.ts";

test.skipIf(!["linux", "darwin"].includes(process.platform))(
  "host tools resolve symlinks, interpreters and modules without tool-specific grants",
  () => {
    const root = mkdtempSync(join(process.cwd(), ".native-host-tools-"));
    const temporary = mkdtempSync("/tmp/clarvis-host-tools-");
    const home = join(temporary, "home");
    const workspace = join(temporary, "workspace");
    const scratch = join(temporary, "scratch");
    const bin = join(root, "operator-bin");
    const library = join(root, "installation", "lib");
    const global = join(home, ".clarvis");
    for (const path of [home, workspace, scratch, bin, library, global]) {
      mkdirSync(path, { recursive: true });
    }
    const entry = join(library, "entry.ts");
    const module = join(library, "value.ts");
    writeFileSync(module, 'export const value = "HOST_TOOL_DEPENDENCY_OK";\n');
    writeFileSync(
      entry,
      `#!${process.execPath}\nimport { value } from "./value.ts";\nprocess.stdout.write(value);\n`,
    );
    chmodSync(entry, 0o755);
    symlinkSync(entry, join(bin, "operator-tool"));
    const secret = join(root, "credential.txt");
    writeFileSync(secret, "private-credential");
    symlinkSync(secret, join(home, ".netrc"));
    writeFileSync(join(home, ".npmrc"), "private-registry-token");
    writeFileSync(join(global, "keys.json"), "private-global");
    const backend = process.platform === "linux" ? new BubblewrapBackend() : new SeatbeltBackend();
    const run = (command: string, workspaceAccess: "read-only" | "read-write" = "read-only") => {
      const policy = createExecutionPolicy({
        id: "host-tools",
        mode: "sandbox",
        homeRoot: home,
        globalRoot: global,
        workspaceRoot: workspace,
        workspaceAccess,
        temporaryWriteRoots: [scratch],
        network: "disabled",
      });
      const spec = prepareLaunch(
        policy,
        {
          file: "/bin/sh",
          args: ["-c", command],
          cwd: workspace,
          env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, TMPDIR: scratch },
        },
        backend,
      );
      return spawnSync(spec.file, [...spec.args], {
        cwd: spec.cwd,
        env: spec.env,
        encoding: "utf8",
        timeout: 5000,
      });
    };
    try {
      const tool = run("operator-tool");
      expect({ status: tool.status, stdout: tool.stdout, stderr: tool.stderr }).toEqual({
        status: 0,
        stdout: "HOST_TOOL_DEPENDENCY_OK",
        stderr: "",
      });
      expect(run(`printf breach > '${module}'`).status).not.toBe(0);
      expect(run(`printf breach > '${join(dirname(module), "new.ts")}'`).status).not.toBe(0);
      expect(readFileSync(module, "utf8")).toContain("HOST_TOOL_DEPENDENCY_OK");
      expect(run("printf breach > readonly.txt").status).not.toBe(0);
      expect(existsSync(join(workspace, "readonly.txt"))).toBe(false);
      expect(run("printf ok > writable.txt", "read-write").status).toBe(0);
      expect(run('printf ok > "$TMPDIR/scratch.txt"').status).toBe(0);
      expect(run('printf breach > "$HOME/host-settings"').status).not.toBe(0);
      for (const path of [
        secret,
        join(home, ".netrc"),
        join(home, ".npmrc"),
        join(global, "keys.json"),
      ]) {
        expect(run(`cat '${path}'`).status).toBe(0);
      }
      expect(readFileSync(secret, "utf8")).toBe("private-credential");
      expect(readFileSync(join(home, ".npmrc"), "utf8")).toBe("private-registry-token");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(temporary, { recursive: true, force: true });
    }
  },
);
