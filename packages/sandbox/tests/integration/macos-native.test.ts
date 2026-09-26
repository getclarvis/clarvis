import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
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
import { createServer } from "node:tls";
import { createExecutionPolicy, prepareLaunch, SeatbeltBackend } from "../../src/index.ts";

test.skipIf(process.platform !== "darwin")(
  "Seatbelt enforces global exceptions and workspace read-only",
  () => {
    const root = mkdtempSync(join(process.cwd(), ".native-seatbelt-"));
    const workspace = join(root, "workspace");
    const sibling = join(root, "sibling");
    const home = join(root, "home");
    const global = join(home, ".clarvis");
    const agents = join(home, ".agents");
    const workflows = join(global, "workflows");
    for (const path of [workspace, sibling, global, agents, workflows])
      mkdirSync(path, { recursive: true });
    const settings = join(global, "settings.json");
    const privatePaths = [
      join(global, "keys.json"),
      ...["subscriptions", "state", "cache", "agents"].map((name) =>
        join(global, name, "private.txt"),
      ),
      ...[".ssh", ".aws", ".config", ".gnupg", ".kube"].map((name) =>
        join(home, name, "private.txt"),
      ),
    ];
    writeFileSync(settings, "before");
    for (const path of privatePaths) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "private");
    }
    writeFileSync(join(sibling, "private.txt"), "sibling-private");
    symlinkSync(privatePaths[0]!, join(workspace, "secret-link"));
    writeFileSync(join(agents, "agent.txt"), "agent");
    writeFileSync(join(workflows, "workflow.txt"), "workflow");
    const backend = new SeatbeltBackend();
    const run = (command: string) => {
      const policy = createExecutionPolicy({
        id: "seatbelt-native",
        mode: "sandbox",
        workspaceRoot: workspace,
        workspaceAccess: "read-only",
        homeRoot: home,
        globalRoot: global,
        temporaryWriteRoots: ["/tmp"],
      });
      const spec = prepareLaunch(
        policy,
        { file: "/bin/sh", args: ["-c", command], cwd: workspace, env: { PATH: "/usr/bin:/bin" } },
        backend,
      );
      expect(spec.backend).toBe("seatbelt");
      return spawnSync(spec.file, [...spec.args], {
        cwd: spec.cwd,
        env: spec.env,
        encoding: "utf8",
        timeout: 5000,
      });
    };
    try {
      expect(run(`cat '${join(agents, "agent.txt")}'`).stdout).toBe("agent");
      expect(run(`cat '${join(workflows, "workflow.txt")}'`).stdout).toBe("workflow");
      expect(run(`cat '${settings}'`).stdout).toBe("before");
      for (const path of privatePaths) {
        expect(run(`cat '${path}'`).status).not.toBe(0);
        expect(run(`printf breach > '${path}'`).status).not.toBe(0);
        expect(readFileSync(path, "utf8")).toBe("private");
      }
      expect(run(`cat '${join(sibling, "private.txt")}'`).stdout).toBe("sibling-private");
      expect(run(`printf breach > '${join(sibling, "new.txt")}'`).status).not.toBe(0);
      expect(existsSync(join(sibling, "new.txt"))).toBe(false);
      expect(run("cat secret-link").status).not.toBe(0);
      expect(run(`printf changed > '${settings}'`).status).toBe(0);
      expect(readFileSync(settings, "utf8")).toBe("changed");
      expect(run(`printf blocked > '${join(workspace, "blocked")}'`).status).not.toBe(0);
      const hostTemporary = join("/tmp", `clarvis-seatbelt-native-${process.pid}`);
      try {
        writeFileSync(hostTemporary, "before");
        expect(run(`printf temp > '${hostTemporary}'`).status).toBe(0);
        expect(readFileSync(hostTemporary, "utf8")).toBe("temp");
      } finally {
        rmSync(hostTemporary, { force: true });
      }
      for (const path of privatePaths) expect(readFileSync(path, "utf8")).toBe("private");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "darwin")(
  "Seatbelt keeps a redirected global root private inside the real /tmp",
  () => {
    const root = mkdtempSync(join(process.cwd(), ".native-seatbelt-redirect-"));
    const temporary = mkdtempSync(join("/tmp", "clarvis-seatbelt-global-"));
    const workspace = join(root, "workspace");
    const home = join(root, "home");
    const global = join(temporary, "global");
    const workflows = join(global, "workflows");
    const settings = join(global, "settings.json");
    const privateFile = join(global, "keys.json");
    for (const path of [workspace, home, global, workflows]) mkdirSync(path, { recursive: true });
    writeFileSync(settings, "before");
    writeFileSync(privateFile, "private");
    const policy = createExecutionPolicy({
      id: "seatbelt-redirected",
      mode: "sandbox",
      workspaceRoot: workspace,
      workspaceAccess: "read-only",
      homeRoot: home,
      globalRoot: global,
      temporaryWriteRoots: ["/tmp"],
    });
    const run = (command: string) => {
      const spec = prepareLaunch(
        policy,
        { file: "/bin/sh", args: ["-c", command], cwd: workspace, env: { PATH: "/usr/bin:/bin" } },
        new SeatbeltBackend(),
      );
      return spawnSync(spec.file, [...spec.args], {
        cwd: spec.cwd,
        env: spec.env,
        encoding: "utf8",
        timeout: 5000,
      });
    };
    try {
      expect(run(`cat '${settings}'`).stdout).toBe("before");
      expect(run(`cat '${privateFile}'`).status).not.toBe(0);
      expect(run(`printf breach > '${privateFile}'`).status).not.toBe(0);
      expect(readFileSync(privateFile, "utf8")).toBe("private");
      expect(run(`printf changed > '${settings}'`).status).toBe(0);
      expect(readFileSync(settings, "utf8")).toBe("changed");
      expect(run(`printf flow > '${join(workflows, "run.txt")}'`).status).toBe(0);
      expect(readFileSync(join(workflows, "run.txt"), "utf8")).toBe("flow");
      rmSync(settings);
      expect(run(`printf created > '${settings}'`).status).not.toBe(0);
      expect(existsSync(settings)).toBe(false);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "darwin")(
  "Seatbelt permits local TLS only with network enabled",
  async () => {
    const root = mkdtempSync(join(process.cwd(), ".native-seatbelt-tls-"));
    const workspace = join(root, "workspace");
    const home = join(root, "home");
    const key = join(root, "tls-key.pem");
    const certificate = join(root, "tls-cert.pem");
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
      const server = createServer(
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
        const run = async (network: "enabled" | "disabled") => {
          const policy = createExecutionPolicy({
            id: `seatbelt-tls-${network}`,
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
              args: ["-kfsS", "--max-time", "3", `https://127.0.0.1:${address.port}/`],
              cwd: workspace,
              env: { PATH: "/usr/bin:/bin" },
            },
            new SeatbeltBackend(),
          );
          return new Promise<{ code: number | null; stdout: string; stderr: string }>(
            (resolve, reject) => {
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
              child.once("error", reject);
              child.once("close", (code) => resolve({ code, stdout, stderr }));
            },
          );
        };
        expect(await run("enabled")).toMatchObject({ code: 0, stdout: "ok" });
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
