import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { containerDataVolumeNames, containerGuestPaths, globalPaths } from "@clarvis/paths";
import {
  containerVolumeUser,
  migrateContainerDomainState,
  prepareContainerVolumes,
  resolveContainerVolumeIdentity,
  type ContainerVolumePreparer,
} from "../../src/runtime/container-volumes.ts";
import type { DockerControl, DockerCommandResult } from "../../src/runtime/docker-backend.ts";

const namespace = "a".repeat(64);
const names = containerDataVolumeNames(namespace);
const roots: string[] = [];
async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "container-volumes-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const result = (stdout = "", exitCode = 0): DockerCommandResult => ({
  stdout,
  stderr: "",
  exitCode,
});
function volume(name: string) {
  return {
    Name: name,
    Driver: "local",
    Scope: "local",
    Options: null,
    Labels: {
      "io.clarvis.managed": "true",
      "io.clarvis.state.schema": "1",
      "io.clarvis.state.namespace": namespace,
      "io.clarvis.state.role": name.endsWith("-content") ? "content" : "state",
    },
  };
}
function fixture(existing = true) {
  const volumes = new Map<string, ReturnType<typeof volume>>(
    existing ? Object.values(names).map((name) => [name, volume(name)]) : [],
  );
  const commands: (readonly string[])[] = [];
  const requests: Parameters<ContainerVolumePreparer["run"]>[0][] = [];
  const control: DockerControl = {
    async run(args) {
      commands.push(args);
      if (args[1] === "inspect")
        return volumes.has(args[2]!)
          ? result(JSON.stringify([volumes.get(args[2]!)]))
          : result("", 1);
      if (args[1] === "ls") return result([...volumes.keys()].join("\n"));
      if (args[1] === "create") {
        const name = args.at(-1)!;
        volumes.set(name, volume(name));
        return result(name);
      }
      throw new Error("unexpected engine operation");
    },
    attach() {
      throw new Error("no attach in volume module");
    },
  };
  const preparer: ContainerVolumePreparer = {
    async run(request) {
      requests.push(request);
      return {
        result: result(),
        evidence: { containerId: "b".repeat(64), labels: request.labels, removed: true },
      };
    },
  };
  const options = {
    control,
    preparer,
    namespace,
    generation: "test-generation",
    baseImageId: `sha256:${"c".repeat(64)}`,
    user: { uid: 1000, gid: 1000 },
    engine: "docker" as const,
  };
  return { volumes, commands, requests, options };
}

describe("container volume namespace", () => {
  test("canonical realpaths and invoking account; no artifact or engine dimension", async () => {
    const root = await scratch();
    const workspaceRoot = join(root, "workspace");
    const globalDir = join(root, "global");
    const second = join(root, "second");
    await Promise.all([workspaceRoot, globalDir, second].map((path) => mkdir(path)));
    const alias = join(root, "alias");
    await symlink(workspaceRoot, alias, "junction");
    const options = { workspaceRoot, globalDir, projectId: "project" };
    const identity = await resolveContainerVolumeIdentity(options);
    const account = userInfo();
    expect(identity.namespace).toBe(
      createHash("sha256")
        .update(
          JSON.stringify({
            schema: 1,
            placement: "container",
            operatorId:
              account.uid >= 0 ? String(account.uid) : `${account.username}:${account.homedir}`,
            globalRoot: await realpath(globalDir),
            projectId: "project",
            workspaceRoot: await realpath(workspaceRoot),
          }),
        )
        .digest("hex"),
    );
    expect(
      (await resolveContainerVolumeIdentity({ ...options, workspaceRoot: alias })).namespace,
    ).toBe(identity.namespace);
    expect(
      (await resolveContainerVolumeIdentity({ ...options, workspaceRoot: second })).namespace,
    ).not.toBe(identity.namespace);
    expect(
      (
        await resolveContainerVolumeIdentity({
          ...options,
          ...{ artifact: "different", engine: "podman", generation: "different" },
        })
      ).namespace,
    ).toBe(identity.namespace);
  });
  test("refuses global roots and real secret stores inside workspace, including dangling links", async () => {
    const root = await scratch();
    const workspaceRoot = join(root, "workspace");
    const globalDir = join(root, "global");
    await mkdir(workspaceRoot);
    await mkdir(globalDir);
    const options = { workspaceRoot, globalDir, projectId: "project" };
    await expect(
      resolveContainerVolumeIdentity({ ...options, globalDir: workspaceRoot }),
    ).rejects.toMatchObject({ code: "unauthorized" });
    const secret = join(workspaceRoot, "private");
    await writeFile(secret, "fixture");
    await symlink(secret, globalPaths(globalDir).keysFile);
    await expect(resolveContainerVolumeIdentity(options)).rejects.toMatchObject({
      code: "unauthorized",
    });
    await rm(secret);
    await expect(resolveContainerVolumeIdentity(options)).rejects.toThrow();
  });
  test("only nonroot numeric guest UID/GID", () => {
    expect(containerVolumeUser({ uid: 1234, gid: 5678 })).toBe("1234:5678");
    for (const id of [0, -1, NaN, Infinity, 1.5, 4294967295]) {
      expect(() => containerVolumeUser({ uid: id, gid: 1000 })).toThrow();
      expect(() => containerVolumeUser({ uid: 1000, gid: id })).toThrow();
    }
  });
});

describe("container pair admission", () => {
  test("migrates only the admitted domain directories through one bounded preparer", async () => {
    const f = fixture();
    const root = await scratch();
    const mounts = await Promise.all(
      Array.from({ length: 8 }, async (_, index) => {
        const source = join(root, String(index));
        await mkdir(source);
        return {
          source,
          target: `/target/${String(index)}`,
          type: "directory" as const,
          readOnly: false as const,
        };
      }),
    );
    await migrateContainerDomainState({
      preparer: f.options.preparer,
      volumes: {
        namespace,
        content: { name: names.content, subpath: "data", target: containerGuestPaths.contentRoot },
        state: { name: names.state, subpath: "data", target: containerGuestPaths.globalRoot },
      },
      mounts,
      namespace,
      generation: "test-generation",
      baseImageId: f.options.baseImageId,
      owner: "owner",
      projectId: "project",
      workspaceId: "workspace",
      user: f.options.user,
      engine: "docker",
    });
    const request = f.requests[0]!;
    expect(request.policy.capabilityAdditions).toEqual([]);
    expect(request.policy.mounts).toHaveLength(9);
    expect(request.policy.mounts[0]).toEqual({
      type: "volume",
      source: names.state,
      target: "/legacy-state",
      writable: true,
    });
    expect(request.policy.mounts.slice(1).every((mount) => mount.type === "bind")).toBe(true);
    expect(request.createArgs).not.toContain("--cap-add");
    expect(request.createArgs).not.toContain("--env");
    expect(request.createArgs).toContain("/bin/bash");
  });

  test("refuses an incomplete migration map before creating a preparer", async () => {
    const f = fixture();
    await expect(
      migrateContainerDomainState({
        preparer: f.options.preparer,
        volumes: {
          namespace,
          content: {
            name: names.content,
            subpath: "data",
            target: containerGuestPaths.contentRoot,
          },
          state: { name: names.state, subpath: "data", target: containerGuestPaths.globalRoot },
        },
        mounts: [],
        namespace,
        generation: "test-generation",
        baseImageId: f.options.baseImageId,
        owner: "owner",
        projectId: "project",
        workspaceId: "workspace",
        user: f.options.user,
        engine: "podman",
      }),
    ).rejects.toMatchObject({ code: "invalid_launch_spec" });
    expect(f.requests).toHaveLength(0);
  });

  test("creates exactly two local named data volumes; private subpaths and bounded preparers", async () => {
    const f = fixture(false);
    const prepared = await prepareContainerVolumes(f.options);
    expect(f.commands.filter((args) => args[1] === "create")).toHaveLength(2);
    expect(prepared.content).toEqual({
      name: names.content,
      subpath: "data",
      target: containerGuestPaths.contentRoot,
    });
    expect(prepared.state.target).toBe(containerGuestPaths.globalRoot);
    expect(f.requests).toHaveLength(2);
    for (const request of f.requests) {
      const args = request.createArgs;
      expect(args.slice(0, 5)).toEqual(["create", "--network", "none", "--read-only", "--user"]);
      expect(args).toContain("no-new-privileges=true");
      expect(args).toContain("67108864");
      expect(args).not.toContain("--env");
      expect(args.join(" ")).not.toContain("type=bind");
      expect(args).not.toContain("FOWNER");
      expect(args).not.toContain("DAC_OVERRIDE");
      expect(args.filter((arg) => arg.startsWith("type=volume,"))).toHaveLength(2);
      expect(args.at(-1)).toBe("1000:1000");
    }
    expect(f.requests[0]!.createArgs).toContain("CHOWN");
    expect(f.requests[1]!.createArgs).not.toContain("--cap-add");
  });
  test("future schema, ownership labels and local driver options conflict before any preparer", async () => {
    for (const change of [
      (v: ReturnType<typeof volume>) => {
        v.Labels["io.clarvis.state.schema"] = "2";
      },
      (v: ReturnType<typeof volume>) => {
        v.Labels["io.clarvis.state.namespace"] = "foreign";
      },
      (v: ReturnType<typeof volume>) => {
        v.Driver = "nfs";
      },
      (v: ReturnType<typeof volume>) => {
        v.Name = "foreign";
      },
      (v: ReturnType<typeof volume>) => {
        Object.assign(v, { Options: { type: "none", device: "/host", o: "bind" } });
      },
      (v: ReturnType<typeof volume>) => {
        Object.assign(v.Labels, { owner: "private" });
      },
    ]) {
      const f = fixture();
      change(f.volumes.get(names.content)!);
      await expect(prepareContainerVolumes(f.options)).rejects.toMatchObject({ code: "conflict" });
      expect(f.requests).toHaveLength(0);
      expect(f.commands.some((args) => args[1] === "create")).toBe(false);
    }
  });
  test("inspect errors are not absence when listing fails or confirms existence", async () => {
    for (const listing of [result("", 1), result(names.content)]) {
      const f = fixture();
      f.options.control.run = async (args) => {
        f.commands.push(args);
        return args[1] === "ls" ? listing : result("", 1);
      };
      await expect(prepareContainerVolumes(f.options)).rejects.toThrow();
      expect(f.commands.some((args) => args[1] === "create")).toBe(false);
    }
  });
  test("cancellation, preparation conflicts, engine and cleanup failures never delete volumes", async () => {
    for (const mode of ["cancel", "conflict", "failure", "cleanup"] as const) {
      const f = fixture(false);
      const abort = new AbortController();
      f.options.preparer.run = async (request) => {
        if (mode === "cancel") {
          abort.abort();
          throw abort.signal.reason;
        }
        return {
          result: result("", mode === "conflict" ? 73 : mode === "failure" ? 1 : 0),
          evidence: {
            containerId: "d".repeat(64),
            labels: mode === "cleanup" ? {} : request.labels,
            removed: true,
          },
        };
      };
      await expect(
        prepareContainerVolumes({ ...f.options, signal: abort.signal }),
      ).rejects.toThrow();
      expect(f.volumes.size).toBe(2);
      expect(f.commands.some((args) => args.includes("rm") || args.includes("prune"))).toBe(false);
    }
    const f = fixture();
    await expect(
      prepareContainerVolumes({ ...f.options, signal: AbortSignal.abort() }),
    ).rejects.toThrow();
    expect(f.commands).toHaveLength(0);
  });
});

/** Execute the fixed shell program on scratch directories with simulated container stat/chown.
 * This tests shell control flow and on-disk ordering, not engine capabilities or mapped ownership. */
async function scriptFixture() {
  const f = fixture();
  await prepareContainerVolumes(f.options);
  const root = await scratch();
  const bin = join(root, "bin");
  await Promise.all([bin, join(root, "content"), join(root, "state")].map((path) => mkdir(path)));
  const log = join(root, "chown-log");
  await writeFile(join(bin, "chown"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TEST_LOG"\n');
  await writeFile(
    join(bin, "stat"),
    `#!/bin/sh
case "$3" in
  */ready) printf '0:0:600\\n';;
  */data|*/home) printf '%s:700\\n' "\${TEST_OWNER:-1000:1000}";;
  *) printf '0:0:755\\n';;
esac
`,
  );
  await Promise.all(["chown", "stat"].map((name) => chmod(join(bin, name), 0o755)));
  const script = f.requests[0]!.createArgs.at(-3)!.replace(
    /\/(content|state)/gu,
    (_match, role: string) => join(root, role),
  );
  return {
    root,
    log,
    async run(owner = "1000:1000") {
      const child = Bun.spawn(["/bin/sh", "-euc", script, "fixture", "1000:1000"], {
        env: { PATH: `${bin}:/usr/bin:/bin`, TEST_LOG: log, TEST_OWNER: owner },
        stdout: "pipe",
        stderr: "pipe",
      });
      return child.exited;
    },
  };
}

describe.skipIf(process.platform === "win32")("fixed preparer shell control flow", () => {
  test("canonical host state wins over divergent legacy domain bytes", async () => {
    const f = fixture();
    const root = await scratch();
    const mounts = await Promise.all(
      Array.from({ length: 8 }, async (_, index) => {
        const source = join(root, "canonical", String(index));
        await mkdir(source, { recursive: true });
        return {
          source,
          target: `/target/${String(index)}`,
          type: "directory" as const,
          readOnly: false as const,
        };
      }),
    );
    await mkdir(join(root, "legacy-content", "data", "plans"), { recursive: true });
    await mkdir(join(root, "legacy-state", "data"), { recursive: true });
    await writeFile(join(root, "legacy-content", "data", "plans", "plan.md"), "legacy");
    await migrateContainerDomainState({
      preparer: f.options.preparer,
      volumes: {
        namespace,
        content: { name: names.content, subpath: "data", target: containerGuestPaths.contentRoot },
        state: { name: names.state, subpath: "data", target: containerGuestPaths.globalRoot },
      },
      mounts,
      namespace,
      generation: "test-generation",
      baseImageId: f.options.baseImageId,
      owner: "owner",
      projectId: "project",
      workspaceId: "workspace",
      user: f.options.user,
      engine: "docker",
    });
    const args = f.requests[0]!.createArgs;
    const scriptIndex = args.indexOf("-euc") + 1;
    const script = args[scriptIndex]!.replaceAll("/legacy-content", join(root, "legacy-content"))
      .replaceAll("/legacy-state", join(root, "legacy-state"))
      .replaceAll("/canonical", join(root, "canonical"));
    const child = Bun.spawn(
      ["/bin/bash", "-euc", script, "fixture", args[scriptIndex + 2]!, args[scriptIndex + 3]!],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await child.exited).toBe(0);
    await expect(readFile(join(root, "canonical", "0", "plan.md"), "utf8")).rejects.toThrow();
    expect(await readFile(join(root, "legacy-content", "data", "plans", "plan.md"), "utf8")).toBe(
      "legacy",
    );
    const stateRoot = join(root, "legacy-state", "data", "state");
    const owner = args[scriptIndex + 2]!;
    const workspace = args[scriptIndex + 3]!;
    for (const directory of [
      join(stateRoot, "workspaces", workspace, "plans"),
      join(stateRoot, "workspaces", workspace, "memory"),
      join(stateRoot, "workspaces", workspace, "trace-locks"),
      join(stateRoot, "traces", owner),
      join(stateRoot, "sessions", owner),
      join(stateRoot, "workflows", owner),
    ])
      expect((await stat(directory)).isDirectory()).toBe(true);
    expect(
      await readFile(join(root, "legacy-state", "data", ".domain-state-host-v1"), "utf8"),
    ).toBe("1\n");
    await rm(join(root, "legacy-state", "data", ".domain-state-host-v1"));
    await writeFile(join(root, "canonical", "0", "plan.md"), "different");
    const divergent = Bun.spawn(
      ["/bin/bash", "-euc", script, "fixture", args[scriptIndex + 2]!, args[scriptIndex + 3]!],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await divergent.exited).toBe(0);
    expect(await readFile(join(root, "canonical", "0", "plan.md"), "utf8")).toBe("different");
    expect(await readFile(join(root, "legacy-content", "data", "plans", "plan.md"), "utf8")).toBe(
      "legacy",
    );
  });

  test("new pair publishes markers last and reuse never chowns; ownership conflict refuses unchanged", async () => {
    const f = await scriptFixture();
    expect(await f.run()).toBe(0);
    expect(await readFile(join(f.root, "content/ready"), "utf8")).toBe("1:1000:1000\n");
    expect(await readFile(join(f.root, "state/ready"), "utf8")).toBe("1:1000:1000\n");
    const log = await readFile(f.log, "utf8");
    expect(log).not.toContain("-R");
    expect(await f.run()).toBe(0);
    expect(await readFile(f.log, "utf8")).toBe(log);
    expect(await f.run("2000:2000")).toBe(73);
    expect(await readFile(f.log, "utf8")).toBe(log);
  });
  test("partial nonempty pair and partial marker refuse with zero chown and no erasure", async () => {
    for (const leaf of ["payload", "ready"]) {
      const f = await scriptFixture();
      const path = join(f.root, "content", leaf);
      await writeFile(path, "retained");
      expect(await f.run()).toBe(73);
      expect(await readFile(path, "utf8")).toBe("retained");
      await expect(readFile(f.log)).rejects.toThrow();
    }
  });
});
