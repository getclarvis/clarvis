import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { createServer as createTlsServer } from "node:tls";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  BubblewrapBackend,
  createExecutionPolicy,
  prepareLaunch,
  SandboxSetupError,
} from "../../src/index.ts";

function createDeniedHomeDirectories(home: string): void {
  for (const name of [".ssh", ".aws", ".config", ".gnupg", ".kube"]) {
    mkdirSync(join(home, name));
  }
}

test.skipIf(process.platform !== "linux")(
  "Bubblewrap enforces workspace writes and explicit read denies",
  () => {
    const root = mkdtempSync(join(process.cwd(), ".native-sandbox-"));
    const workspace = join(root, "workspace");
    const sibling = join(root, "sibling");
    const home = join(root, "home");
    const global = join(home, ".clarvis");
    const agents = join(home, ".agents");
    const workflows = join(global, "workflows");
    for (const path of [workspace, sibling, global, agents, workflows])
      mkdirSync(path, { recursive: true });
    createDeniedHomeDirectories(home);
    const settings = join(global, "settings.json");
    const privateFile = join(global, "keys.json");
    const privatePaths = [
      privateFile,
      ...["subscriptions", "state", "cache", "agents"].map((name) =>
        join(global, name, "private.txt"),
      ),
      ...[".ssh", ".aws", ".config", ".gnupg", ".kube"].map((name) =>
        join(home, name, "private.txt"),
      ),
    ];
    writeFileSync(settings, "settings-before");
    for (const path of privatePaths) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "private-before");
    }
    writeFileSync(join(agents, "agent.txt"), "agent-before");
    writeFileSync(join(workflows, "workflow.txt"), "workflow-before");
    writeFileSync(join(sibling, "private.txt"), "sibling-private");
    for (const name of [".clarvis", ".agents", ".aws"]) {
      mkdirSync(join(workspace, name));
      writeFileSync(join(workspace, name, "metadata.txt"), "metadata-before");
    }
    const linkedGitDir = join(sibling, "worktree-git");
    mkdirSync(linkedGitDir);
    writeFileSync(join(linkedGitDir, "HEAD"), "ref: refs/heads/test\n");
    writeFileSync(join(workspace, ".git"), `gitdir: ${linkedGitDir}\n`);
    symlinkSync(join(workspace, ".clarvis"), join(workspace, "metadata-alias"));
    const backend = new BubblewrapBackend();
    const temporaryProbe = join("/tmp", `clarvis-sandbox-native-${process.pid}`);
    const sharedProbe = join("/dev/shm", `clarvis-sandbox-native-${process.pid}`);
    const run = (
      command: string,
      workspaceAccess: "read-write" | "read-only" = "read-write",
      denies: readonly string[] = [],
    ) => {
      const policy = createExecutionPolicy({
        id: "native-test",
        mode: "sandbox",
        workspaceRoot: workspace,
        workspaceAccess,
        homeRoot: home,
        globalRoot: global,
        temporaryWriteRoots: ["/tmp"],
        denies,
      });

      const spec = prepareLaunch(
        policy,
        { file: "/bin/sh", args: ["-c", command], cwd: workspace, env: { PATH: "/usr/bin:/bin" } },
        backend,
      );
      expect(spec.backend).toBe("bubblewrap");
      return spawnSync(spec.file, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
        encoding: "utf8",
        timeout: 5000,
      });
    };
    try {
      expect(run(`cat '${join(agents, "agent.txt")}'`).stdout).toBe("agent-before");
      expect(run(`cat '${join(workflows, "workflow.txt")}'`).stdout).toBe("workflow-before");
      expect(run(`cat '${settings}'`).stdout).toBe("settings-before");
      for (const file of ["/etc/hosts", "/etc/resolv.conf", "/etc/nsswitch.conf"]) {
        if (!existsSync(file)) continue;
        const mounted = run(`cat '${file}'`);
        expect(mounted.status).toBe(0);
        expect(mounted.stdout).toBe(readFileSync(file, "utf8"));
      }
      for (const path of privatePaths) {
        expect(run(`cat '${path}'`).status).toBe(0);
        const write = run(`printf breach > '${path}'`);
        if (write.status === 0) throw new Error(`private path was writable: ${path}`);
      }
      expect(run(`cat '${join(sibling, "private.txt")}'`).stdout).toBe("sibling-private");
      for (const name of [".clarvis", ".agents", ".aws"]) {
        const metadataFile = join(workspace, name, "metadata.txt");
        expect(run(`cat '${metadataFile}'`).stdout).toBe("metadata-before");
        expect(run(`printf breach > '${metadataFile}'`).status).not.toBe(0);
        expect(readFileSync(metadataFile, "utf8")).toBe("metadata-before");
      }
      expect(run("printf breach > metadata-alias/metadata.txt").status).not.toBe(0);
      expect(run(`printf breach > '${join(linkedGitDir, "HEAD")}'`).status).not.toBe(0);
      expect(run("printf breach > .git").status).not.toBe(0);
      expect(readFileSync(join(linkedGitDir, "HEAD"), "utf8")).toBe("ref: refs/heads/test\n");
      expect(run(`printf breach > '${join(sibling, "new.txt")}'`).status).not.toBe(0);
      expect(existsSync(join(sibling, "new.txt"))).toBe(false);
      const deniedFile = join(workspace, "denied.txt");
      writeFileSync(deniedFile, "secret");
      expect(run("cat denied.txt", "read-write", [deniedFile]).status).not.toBe(0);
      expect(run("printf breach > denied.txt", "read-write", [deniedFile]).status).not.toBe(0);
      expect(readFileSync(deniedFile, "utf8")).toBe("secret");
      symlinkSync(privateFile, join(workspace, "secret-link"));
      expect(run("cat secret-link").status).toBe(0);
      symlinkSync(privateFile, join(agents, "secret-link"));
      expect(run(`cat '${join(agents, "secret-link")}'`).status).toBe(0);
      expect(
        run(`printf agent-after > '${join(agents, "agent.txt")}'`, "read-only").status,
      ).not.toBe(0);
      expect(readFileSync(join(agents, "agent.txt"), "utf8")).toBe("agent-before");
      expect(
        run(`printf workflow-after > '${join(workflows, "workflow.txt")}'`, "read-only").status,
      ).not.toBe(0);
      expect(readFileSync(join(workflows, "workflow.txt"), "utf8")).toBe("workflow-before");
      expect(run(`printf changed > '${settings}'`).status).not.toBe(0);
      expect(readFileSync(settings, "utf8")).toBe("settings-before");
      expect(run(`printf readonly > '${settings}'`, "read-only").status).not.toBe(0);
      expect(readFileSync(settings, "utf8")).toBe("settings-before");
      rmSync(settings);
      expect(run(`printf created > '${settings}'`).status).not.toBe(0);
      expect(run(`printf changed > '${join(workspace, "output")}'`, "read-only").status).not.toBe(
        0,
      );
      expect(run(`printf changed > '${temporaryProbe}'`, "read-only").status).toBe(0);
      expect(readFileSync(temporaryProbe, "utf8")).toBe("changed");
      if (existsSync("/dev/shm")) {
        writeFileSync(sharedProbe, "before");
        expect(run(`printf after > '${sharedProbe}'`, "read-only").status).toBe(0);
        expect(readFileSync(sharedProbe, "utf8")).toBe("after");
      }
      expect(run(`printf changed > '${join(workspace, "output")}'`).status).toBe(0);
      expect(readFileSync(join(workspace, "output"), "utf8")).toBe("changed");
      for (const path of privatePaths) {
        expect(readFileSync(path, "utf8")).toBe("private-before");
      }
      const absentDeny = join(workspace, "blocked-future-directory");
      const policy = createExecutionPolicy({
        id: "missing-deny",
        mode: "sandbox",
        workspaceRoot: workspace,
        homeRoot: home,
        globalRoot: global,
        denies: [absentDeny],
      });
      let setupError: unknown;
      try {
        prepareLaunch(policy, { file: "/bin/true", args: [], cwd: workspace, env: {} }, backend);
      } catch (error) {
        setupError = error;
      }
      expect(setupError).toBeInstanceOf(SandboxSetupError);
      expect((setupError as SandboxSetupError).boundary).toEqual({
        backend: "bubblewrap",
        policyId: "missing-deny",
      });
      expect(existsSync(absentDeny)).toBe(false);
    } finally {
      rmSync(temporaryProbe, { force: true });
      rmSync(sharedProbe, { force: true });
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "linux")(
  "native launcher applies no-new-privileges and seccomp",
  () => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-seccomp-test-"));
    const binary = join(root, "probe");
    try {
      const compiled = spawnSync(
        "cc",
        [
          "-std=c11",
          "-O2",
          "-Wall",
          "-Wextra",
          "-Werror",
          "tests/fixtures/linux-seccomp-probe.c",
          "-o",
          binary,
        ],
        { cwd: process.cwd(), encoding: "utf8" },
      );
      expect(compiled.status).toBe(0);
      const workspace = join(root, "workspace");
      mkdirSync(workspace);
      createDeniedHomeDirectories(root);
      for (const network of ["enabled", "disabled"] as const) {
        const policy = createExecutionPolicy({
          id: `seccomp-${network}`,
          mode: "sandbox",
          workspaceRoot: workspace,
          homeRoot: root,
          globalRoot: join(root, "global"),
          temporaryWriteRoots: ["/tmp"],
          network,
        });
        for (const preferPackaged of [false, true]) {
          const spec = prepareLaunch(
            policy,
            {
              file: binary,
              args: [
                network === "disabled" ? "network-disabled" : "network-enabled",
                String(process.pid),
              ],
              cwd: workspace,
              env: {},
            },
            new BubblewrapBackend(preferPackaged),
          );
          if (preferPackaged) expect(spec.args[1]?.endsWith("/assets/native/bwrap")).toBe(true);
          const result = spawnSync(spec.file, [...spec.args], {
            cwd: spec.cwd,
            env: spec.env,
            encoding: "utf8",
            timeout: 5000,
          });
          expect({ status: result.status, stderr: result.stderr }).toEqual({
            status: 0,
            stderr: "",
          });
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "linux")(
  "network-enabled sandbox connects to a local host server",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-network-test-"));
    const binary = join(root, "probe");
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    createDeniedHomeDirectories(root);
    const compiled = spawnSync(
      "cc",
      [
        "-std=c11",
        "-O2",
        "-Wall",
        "-Wextra",
        "-Werror",
        "tests/fixtures/linux-seccomp-probe.c",
        "-o",
        binary,
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(compiled.status).toBe(0);
    let received = "";
    const delivered = Promise.withResolvers<void>();
    const server = createServer((socket) => {
      socket.on("data", (chunk: Buffer) => {
        received += chunk.toString("utf8");
        if (received.length >= 2) delivered.resolve();
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No TCP port allocated");
      const policy = createExecutionPolicy({
        id: "network-enabled",
        mode: "sandbox",
        workspaceRoot: workspace,
        homeRoot: root,
        globalRoot: join(root, "global"),
        temporaryWriteRoots: ["/tmp"],
        network: "enabled",
      });
      const spec = prepareLaunch(
        policy,
        {
          file: binary,
          args: ["connect-enabled", String(address.port)],
          cwd: workspace,
          env: {},
        },
        new BubblewrapBackend(),
      );
      const child = spawn(spec.file, [...spec.args], {
        cwd: spec.cwd,
        env: spec.env,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5000,
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      const status = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      await delivered.promise;
      expect({ status, stderr, received }).toEqual({ status: 0, stderr: "", received: "ok" });
    } finally {
      server.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "linux")(
  "network-disabled sandbox can use an admitted local Unix socket",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-unix-socket-test-"));
    const workspace = join(root, "workspace");
    const socketPath = join(root, "service.sock");
    mkdirSync(workspace);
    const server = createServer((socket) => {
      socket.once("data", (chunk) => socket.end(chunk));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
      const policy = createExecutionPolicy({
        id: "local-unix-socket",
        mode: "sandbox",
        workspaceRoot: workspace,
        homeRoot: root,
        globalRoot: join(root, "global"),
        network: "disabled",
      });
      const script = `import { connect } from "node:net"; const socket = connect(${JSON.stringify(socketPath)}); socket.on("connect", () => socket.write("ok")); socket.on("data", (chunk) => process.stdout.write(chunk)); socket.on("error", () => process.exit(2));`;
      const spec = prepareLaunch(
        policy,
        { file: process.execPath, args: ["-e", script], cwd: workspace, env: {} },
        new BubblewrapBackend(),
      );
      const child = spawn(spec.file, [...spec.args], {
        cwd: spec.cwd,
        env: spec.env,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5000,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
      });
      const status = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      expect({ status, stdout, stderr }).toEqual({ status: 0, stdout: "ok", stderr: "" });
    } finally {
      server.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "linux")(
  "network-enabled sandbox resolves localhost and completes local TLS",
  async () => {
    const root = mkdtempSync(join(process.cwd(), ".native-linux-tls-"));
    const workspace = join(root, "workspace");
    const home = join(root, "home");
    const key = join(root, "tls-key.pem");
    const certificate = join(workspace, "ca.pem");
    mkdirSync(workspace);
    mkdirSync(home);
    try {
      const generated = spawnSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          key,
          "-out",
          certificate,
          "-days",
          "1",
          "-subj",
          "/CN=localhost",
        ],
        { encoding: "utf8", timeout: 5000 },
      );
      expect(generated.status).toBe(0);
      const server = createTlsServer(
        { key: readFileSync(key), cert: readFileSync(certificate) },
        (socket) => {
          socket.once("data", () => {
            socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
          });
        },
      );
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("No TLS port allocated");
        const backend = new BubblewrapBackend();
        const run = async (network: "enabled" | "disabled") => {
          const policy = createExecutionPolicy({
            id: `linux-tls-${network}`,
            mode: "sandbox",
            workspaceRoot: workspace,
            homeRoot: home,
            globalRoot: join(home, ".clarvis"),
            network,
          });
          const spec = prepareLaunch(
            policy,
            {
              file: "/usr/bin/curl",
              args: [
                "-4fsS",
                "--max-time",
                "3",
                "--cacert",
                certificate,
                `https://localhost:${address.port}/`,
              ],
              cwd: workspace,
              env: { PATH: "/usr/bin:/bin", NO_PROXY: "localhost,127.0.0.1" },
            },
            backend,
          );
          const child = spawn(spec.file, [...spec.args], {
            cwd: spec.cwd,
            env: spec.env,
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 5000,
          });
          let stdout = "";
          let stderr = "";
          child.stdout.setEncoding("utf8");
          child.stderr.setEncoding("utf8");
          child.stdout.on("data", (chunk: string) => (stdout += chunk));
          child.stderr.on("data", (chunk: string) => (stderr += chunk));
          return new Promise<{ code: number | null; stdout: string; stderr: string }>(
            (resolve, reject) => {
              child.once("error", reject);
              child.once("close", (code) => resolve({ code, stdout, stderr }));
            },
          );
        };
        expect(await run("enabled")).toEqual({ code: 0, stdout: "ok", stderr: "" });
        const denied = await run("disabled");
        expect(denied.code).toBeNumber();
        expect(denied.code).not.toBe(0);
        expect(denied.stdout).toBe("");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "linux")(
  "a redirected global root inside /tmp follows the temporary profile",
  () => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-native-redirect-"));
    const workspace = join(root, "workspace");
    const global = join(root, "global");
    mkdirSync(workspace);
    mkdirSync(global);
    createDeniedHomeDirectories(root);
    writeFileSync(join(global, "keys.json"), "private");
    writeFileSync(join(global, "settings.json"), "settings");
    try {
      const policy = createExecutionPolicy({
        id: "redirected",
        mode: "sandbox",
        workspaceRoot: workspace,
        homeRoot: root,
        globalRoot: global,
        temporaryWriteRoots: ["/tmp"],
      });
      const command = `cat '${join(global, "keys.json")}' 2>/dev/null; cat '${join(global, "settings.json")}'`;
      const spec = prepareLaunch(
        policy,
        {
          file: "/bin/sh",
          args: ["-c", command],
          cwd: workspace,
          env: { PATH: "/usr/bin:/bin" },
        },
        new BubblewrapBackend(),
      );
      const result = spawnSync(spec.file, [...spec.args], {
        cwd: spec.cwd,
        env: spec.env,
        encoding: "utf8",
        timeout: 5000,
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("privatesettings");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
