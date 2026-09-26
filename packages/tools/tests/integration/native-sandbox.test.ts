import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { BubblewrapBackend, createExecutionPolicy, SeatbeltBackend } from "@clarvis/sandbox";
import {
  CoordinatedToolExecutor,
  createAgentTools,
  dispatch,
  SandboxToolExecutor,
} from "../../src/index.ts";

function workerTree(pid: number): number[] {
  const listing = spawnSync("ps", ["-e", "-o", "pid=,ppid="], { encoding: "utf8" });
  if (listing.status !== 0) throw new Error(`process inventory failed: ${listing.stderr}`);
  const children = new Map<number, number[]>();
  for (const line of listing.stdout.split("\n")) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (!child || !parent) continue;
    children.set(parent, [...(children.get(parent) ?? []), child]);
  }
  const tree: number[] = [];
  const visit = (parent: number) => {
    for (const child of children.get(parent) ?? []) visit(child);
    tree.push(parent);
  };
  visit(pid);
  return tree;
}

function signalTree(tree: readonly number[], signal: NodeJS.Signals): void {
  for (const pid of tree) {
    try {
      process.kill(pid, signal);
    } catch {
      // A descendant may exit between inventory and signal.
    }
  }
}

test.skipIf(
  !["linux", "darwin"].includes(process.platform) ||
    process.env.CLARVIS_NATIVE_SANDBOX_TEST !== "1",
)("file handlers and shell use the same native boundary", async () => {
  const root = mkdtempSync(join(tmpdir(), "clarvis-native-tools-"));
  const scratch = mkdtempSync(join(tmpdir(), "clarvis-native-tools-scratch-"));
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  const global = join(home, ".clarvis");
  const agents = join(home, ".agents");
  const workflows = join(global, "workflows");
  mkdirSync(workspace);
  mkdirSync(global, { recursive: true });
  mkdirSync(agents);
  mkdirSync(workflows);
  const privatePaths = [
    join(global, "keys.json"),
    ...["subscriptions", "state", "cache", "agents"].map((name) =>
      join(global, name, "private.txt"),
    ),
    ...[".ssh", ".aws", ".config", ".gnupg", ".kube"].map((name) =>
      join(home, name, "private.txt"),
    ),
  ];
  for (const name of [".ssh", ".aws", ".config", ".gnupg", ".kube"]) {
    mkdirSync(join(home, name));
  }
  for (const path of privatePaths) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "private");
  }
  const secret = privatePaths[0]!;
  const settings = join(global, "settings.json");
  writeFileSync(settings, "before");
  const policy = createExecutionPolicy({
    id: "tools-native",
    mode: "sandbox",
    network: "disabled",
    workspaceRoot: workspace,
    homeRoot: home,
    globalRoot: global,
    temporaryWriteRoots: [scratch, "/tmp"],
    installationRoots: [dirname(process.execPath), resolve(process.cwd(), "../..")],
  });
  const backend = process.platform === "darwin" ? new SeatbeltBackend() : new BubblewrapBackend();
  const executor = new SandboxToolExecutor(policy, backend, scratch);
  const tools = createAgentTools({
    workspaceRoot: workspace,
    temporaryRoots: [scratch],
    executionPolicy: policy,
    sandboxBackend: backend,
    executionPort: executor,
  });
  try {
    const written = await tools.callTool("write_file", { path: "output.txt", content: "hello" });
    expect(written.isError).toBe(false);
    expect(readFileSync(join(workspace, "output.txt"), "utf8")).toBe("hello");
    const read = await tools.callTool("read_file", { path: "output.txt" });
    expect(read.isError).toBe(false);
    expect(read.meta?.execution_mode).toBe("sandbox");
    expect(read.meta?.execution_started).toBe(true);
    const edited = await tools.callTool("edit_file", {
      path: "output.txt",
      old_string: "hello",
      new_string: "edited",
    });
    expect(edited.isError).toBe(false);
    const patched = await tools.callTool("apply_patch", {
      patch: "*** Begin Patch\n*** Update File: output.txt\n@@\n-edited\n+patched\n*** End Patch",
    });
    expect(patched.isError).toBe(false);
    expect(readFileSync(join(workspace, "output.txt"), "utf8")).toBe("patched");
    const largeBefore = "a".repeat(4_000);
    writeFileSync(join(workspace, "large.txt"), largeBefore);
    const largeEdit = await dispatch(
      "edit_file",
      { path: "large.txt", old_string: largeBefore, new_string: "b".repeat(4_000) },
      { ...tools.config, maxToolMetaBytes: 1_024 },
    );
    expect(largeEdit.isError).toBe(false);
    expect(largeEdit.meta).toMatchObject({
      execution_mode: "sandbox",
      execution_backend: backend.name,
      policy_id: policy.id,
      truncated: true,
      execution_diagnostic: { mode: "sandbox", backend: backend.name, policyId: policy.id },
    });
    expect(Buffer.byteLength(JSON.stringify(largeEdit.meta), "utf8")).toBeLessThanOrEqual(1_024);
    for (const path of privatePaths) {
      expect((await tools.callTool("read_file", { path })).isError).toBe(true);
      expect((await tools.callTool("write_file", { path, content: "breach" })).isError).toBe(true);
      expect(readFileSync(path, "utf8")).toBe("private");
    }
    const shell = await tools.callTool("shell", { command: "cat output.txt" });
    expect(shell.isError).toBe(false);
    expect(JSON.stringify(shell.content)).toContain("patched");
    expect(shell.meta?.execution_backend).toBe(backend.name);
    const environment = await tools.callTool("shell", {
      command: 'printf "%s\\n%s\\n" "$HOME" "$CLARVIS_HOME"',
    });
    expect(environment.isError).toBe(false);
    const environmentResult = JSON.parse(
      environment.content.find((part) => part.type === "text")?.text ?? "{}",
    ) as { stdout?: string };
    expect(environmentResult.stdout).toBe(`${realpathSync(home)}\n${realpathSync(global)}\n`);
    const directSettings = await tools.callTool("shell", {
      command: 'printf direct-sandbox-write > "$CLARVIS_HOME/settings.json"',
    });
    expect(directSettings.meta?.execution_mode).toBe("sandbox");
    expect(
      JSON.parse(
        directSettings.content[0]?.type === "text" ? directSettings.content[0].text : "{}",
      ) as { exit_code?: number },
    ).toMatchObject({ exit_code: 0 });
    expect(readFileSync(settings, "utf8")).toBe("direct-sandbox-write");
    expect((await tools.callTool("read_file", { path: settings })).meta?.execution_mode).toBe(
      "sandbox",
    );
    const failedCommand = await tools.callTool("shell", {
      command: "printf command-stderr >&2; exit 7",
    });
    expect(failedCommand.isError).toBe(false);
    expect(failedCommand.meta?.execution_diagnostic).toMatchObject({
      mode: "sandbox",
      backend: backend.name,
      policyId: policy.id,
      executionStarted: true,
      failure: "command_failed",
      exitCode: 7,
      stderr: "command-stderr",
    });
    const harmlessText = await tools.callTool("shell", {
      command: "printf 'Operation not permitted'",
    });
    expect(harmlessText.isError).toBe(false);
    expect(harmlessText.meta?.execution_diagnostic).toMatchObject({
      mode: "sandbox",
      exitCode: 0,
    });
    expect(harmlessText.meta?.execution_diagnostic).not.toHaveProperty("failure");
    const longOutput = await tools.callTool("shell", {
      command: "printf '%0600d' 0",
    });
    expect(longOutput.isError).toBe(false);
    const boundedDiagnostic = longOutput.meta?.execution_diagnostic as { stdout?: string };
    expect(Buffer.byteLength(boundedDiagnostic.stdout ?? "", "utf8")).toBeLessThan(400);
    expect(boundedDiagnostic.stdout).toContain("output truncated");
    const removed = await tools.callTool("remove", { path: "output.txt" });
    expect(removed.isError).toBe(false);
    const worker = executor as unknown as {
      worker?: { pid?: number };
      pending?: { id: number };
    };
    const workerPid = worker.worker?.pid;
    expect(workerPid).toBeNumber();
    const pausedTree = workerTree(workerPid!);
    signalTree(pausedTree, "SIGSTOP");
    try {
      const controller = new AbortController();
      const call = dispatch("read_file", { path: secret }, tools.config, controller.signal);
      const fuse = Date.now() + 5000;
      while (!worker.pending && Date.now() < fuse) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(worker.pending).toBeDefined();
      controller.abort();
      const aborted = await call;
      expect(aborted.isError).toBe(true);
      expect(JSON.stringify(aborted.content)).toContain("aborted");
    } finally {
      try {
        signalTree(pausedTree, "SIGCONT");
      } catch {
        // The abort may already have killed the worker.
      }
    }
    const crashExecutor = new SandboxToolExecutor(policy, backend, scratch);
    const crashTools = createAgentTools({
      workspaceRoot: workspace,
      temporaryRoots: [scratch],
      executionPolicy: policy,
      sandboxBackend: backend,
      executionPort: new CoordinatedToolExecutor(crashExecutor, true),
    });
    try {
      expect((await crashTools.callTool("read_file", { path: settings })).isError).toBe(false);
      const crashedWorker = crashExecutor as unknown as {
        worker?: { pid?: number };
        pending?: { id: number };
      };
      const crashPid = crashedWorker.worker?.pid;
      expect(crashPid).toBeNumber();
      const crashTree = workerTree(crashPid!);
      signalTree(crashTree, "SIGSTOP");
      try {
        const pendingWrite = crashTools.callTool("write_file", {
          path: "uncertain.txt",
          content: "once",
        });
        const fuse = Date.now() + 5000;
        while (!crashedWorker.pending && Date.now() < fuse) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        expect(crashedWorker.pending).toBeDefined();
        signalTree(crashTree, "SIGKILL");
        const unknown = await pendingWrite;
        expect(unknown.isError).toBe(true);
        const diagnostic = JSON.parse(
          unknown.content.find((part) => part.type === "text")?.text ?? "{}",
        );
        expect(diagnostic).toMatchObject({
          error: "outcome_unknown",
          execution_started: true,
          execution_backend: backend.name,
          policy_id: policy.id,
        });
        expect(existsSync(join(workspace, "uncertain.txt"))).toBe(false);
        const later = await crashTools.callTool("write_file", {
          path: "later.txt",
          content: "new-worker",
        });
        expect(later.isError).toBe(false);
        expect(readFileSync(join(workspace, "later.txt"), "utf8")).toBe("new-worker");
      } finally {
        try {
          signalTree(crashTree, "SIGCONT");
        } catch {
          // The crash may already have killed the worker.
        }
      }
    } finally {
      await crashTools.close();
    }
    const readonlyPolicy = createExecutionPolicy({
      id: "tools-native-readonly",
      mode: "sandbox",
      workspaceRoot: workspace,
      workspaceAccess: "read-only",
      homeRoot: home,
      globalRoot: global,
      temporaryWriteRoots: [scratch, "/tmp"],
      installationRoots: [dirname(process.execPath), resolve(process.cwd(), "../..")],
    });
    const readonlyTools = createAgentTools({
      workspaceRoot: workspace,
      temporaryRoots: [scratch],
      executionPolicy: readonlyPolicy,
      sandboxBackend: backend,
      executionPort: new SandboxToolExecutor(readonlyPolicy, backend, scratch),
    });
    try {
      const deniedWrite = await readonlyTools.callTool("write_file", {
        path: "blocked",
        content: "x",
      });
      expect(deniedWrite.isError).toBe(true);
      if (process.platform === "linux") {
        expect(JSON.stringify(deniedWrite.content)).toContain("sandbox_denied");
      }
      const temporaryFile = join(scratch, "allowed");
      expect(
        (await readonlyTools.callTool("write_file", { path: temporaryFile, content: "tmp" }))
          .isError,
      ).toBe(false);
      expect(readFileSync(temporaryFile, "utf8")).toBe("tmp");
      const agentFile = join(agents, "agent.txt");
      const workflowFile = join(workflows, "flow.txt");
      expect(
        (await readonlyTools.callTool("write_file", { path: agentFile, content: "agent" })).isError,
      ).toBe(false);
      expect(readFileSync(agentFile, "utf8")).toBe("agent");
      expect(
        (await readonlyTools.callTool("write_file", { path: workflowFile, content: "flow" }))
          .isError,
      ).toBe(false);
      expect(readFileSync(workflowFile, "utf8")).toBe("flow");
      expect((await readonlyTools.callTool("shell", { command: "pwd" })).isError).toBe(false);
    } finally {
      await readonlyTools.close();
    }
    const recoverableReadonly = createAgentTools({
      workspaceRoot: workspace,
      temporaryRoots: [scratch],
      executionPolicy: readonlyPolicy,
      sandboxBackend: backend,
      executionPort: new CoordinatedToolExecutor(
        new SandboxToolExecutor(readonlyPolicy, backend, scratch),
        true,
      ),
    });
    try {
      const recovered = await recoverableReadonly.callTool("write_file", {
        path: "recovered.txt",
        content: "host-authorized",
      });
      expect(recovered.isError).toBe(false);
      expect(recovered.meta).toMatchObject({
        requested_mode: "sandbox",
        effective_mode: "host",
        fallback_reason: "readonly_workspace",
      });
      expect(readFileSync(join(workspace, "recovered.txt"), "utf8")).toBe("host-authorized");
    } finally {
      await recoverableReadonly.close();
    }
    if (process.platform === "linux") {
      const deniedFile = join(workspace, "explicit-deny.txt");
      writeFileSync(deniedFile, "private");
      const deniedPolicy = createExecutionPolicy({
        id: "tools-native-explicit-deny",
        mode: "sandbox",
        workspaceRoot: workspace,
        homeRoot: home,
        globalRoot: global,
        temporaryWriteRoots: [scratch, "/tmp"],
        installationRoots: [dirname(process.execPath), resolve(process.cwd(), "../..")],
        denies: [deniedFile],
      });
      const deniedTools = createAgentTools({
        workspaceRoot: workspace,
        temporaryRoots: [scratch],
        executionPolicy: deniedPolicy,
        sandboxBackend: backend,
        executionPort: new SandboxToolExecutor(deniedPolicy, backend, scratch),
      });
      try {
        const deniedRead = await deniedTools.callTool("read_file", { path: deniedFile });
        expect(deniedRead.isError).toBe(true);
        expect(JSON.stringify(deniedRead.content)).toContain("sandbox_denied");
        expect(readFileSync(deniedFile, "utf8")).toBe("private");
      } finally {
        await deniedTools.close();
      }
    }
    const settingsPort = new CoordinatedToolExecutor(
      new SandboxToolExecutor(policy, backend, scratch),
      true,
    );
    const settingsTools = createAgentTools({
      workspaceRoot: workspace,
      temporaryRoots: [scratch],
      executionPolicy: policy,
      sandboxBackend: backend,
      executionPort: settingsPort,
    });
    try {
      const replaced = await settingsTools.callTool("write_file", {
        path: settings,
        content: "after",
      });
      expect(replaced.isError).toBe(false);
      expect(replaced.meta?.execution_mode).toBe("host");
      expect(replaced.meta?.sandbox_fallback).toBe(true);
      expect(readFileSync(settings, "utf8")).toBe("after");
      rmSync(settings);
      const created = await settingsTools.callTool("write_file", {
        path: settings,
        content: "created",
      });
      expect(created.isError).toBe(false);
      expect(created.meta?.execution_mode).toBe("host");
      expect(created.meta?.sandbox_fallback).toBe(true);
      expect(readFileSync(settings, "utf8")).toBe("created");
    } finally {
      await settingsTools.close();
    }
    expect(readFileSync(secret, "utf8")).toBe("private");
  } finally {
    await tools.close();
    rmSync(scratch, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
