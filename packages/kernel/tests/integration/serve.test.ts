import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, it, expect, afterEach } from "bun:test";
import { loadEnv } from "@clarvis/capability";
import { createStdioTransport, connectKernelClient } from "../../src/index.ts";
import { createLogger, serveFileKernelOverStdio } from "../../src/bootstrap.ts";

function seedWorkspace(): string {
  const ws = mkdtempSync(join(tmpdir(), "clarvis-serve-"));
  mkdirSync(join(ws, ".clarvis", "agents"), { recursive: true });
  writeFileSync(
    join(ws, ".clarvis", "settings.json"),
    JSON.stringify({
      default_model: "anthropic/x",
      providers: [{ name: "anthropic", kind: "anthropic" }],
    }),
  );
  writeFileSync(
    join(ws, ".clarvis", "agents", "coder.md"),
    `---\nmodel: anthropic/x\ndescription: writes code\n---\n\nYou are a coder.\n`,
  );
  return ws;
}

async function connectOverServe(input: PassThrough, output: PassThrough) {
  const transport = createStdioTransport({ input: output, output: input });
  return connectKernelClient(transport);
}

const originalAgentToolsEnv = process.env.CLARVIS_AGENT_TOOLS_ENABLED;

describe("serveFileKernelOverStdio refuses a logger bound to its own wire", () => {
  it("rejects a stdout logger before constructing anything", async () => {
    const ws = seedWorkspace();
    await expect(
      serveFileKernelOverStdio({
        workspaceRoot: ws,
        logger: createLogger("info", { destination: 1 }),
      }),
    ).rejects.toThrow(/file descriptor 1/);
  });

  it("rejects a derived child of a stdout logger", async () => {
    const ws = seedWorkspace();
    // The shape §9 tells every host to build: one root logger, a child per
    // component. A pino child owns only `chindings`/`formatters`, so its stream
    // is reachable only through its prototype chain.
    const child = createLogger("info", { destination: 1 }).child({ component: "runs" });
    expect(Object.getOwnPropertySymbols(child).map(String).includes("Symbol(pino.stream)")).toBe(
      false,
    );
    await expect(serveFileKernelOverStdio({ workspaceRoot: ws, logger: child })).rejects.toThrow(
      /file descriptor 1/,
    );
  });

  it("rejects a grandchild of a stdout logger", async () => {
    const ws = seedWorkspace();
    const grandchild = createLogger("info", { destination: 1 })
      .child({ component: "runs" })
      .child({ run_id: "r_1" });
    await expect(
      serveFileKernelOverStdio({ workspaceRoot: ws, logger: grandchild }),
    ).rejects.toThrow(/NDJSON wire/);
  });

  it("accepts a derived child of a stderr logger", async () => {
    const ws = seedWorkspace();
    const handle = await serveFileKernelOverStdio({
      workspaceRoot: ws,
      input: new PassThrough(),
      output: new PassThrough(),
      logger: createLogger("silent").child({ component: "runs" }),
    });
    await handle.close();
  });

  it("rejects a logger sharing an explicit output stream's descriptor", async () => {
    const ws = seedWorkspace();
    const output = Object.assign(new PassThrough(), { fd: 1 });
    await expect(
      serveFileKernelOverStdio({
        workspaceRoot: ws,
        output,
        logger: createLogger("info", { destination: 1 }),
      }),
    ).rejects.toThrow(/NDJSON wire/);
  });

  it("accepts a stderr logger, and a stdout logger against a different output", async () => {
    const ws = seedWorkspace();
    const input = new PassThrough();
    const output = new PassThrough();
    const handle = await serveFileKernelOverStdio({
      workspaceRoot: ws,
      input,
      output,
      logger: createLogger("silent"),
    });
    await handle.close();
    const second = await serveFileKernelOverStdio({
      workspaceRoot: ws,
      input: new PassThrough(),
      output: new PassThrough(),
      logger: createLogger("silent", { destination: 1 }),
    });
    await second.close();
  });

  it("accepts a logger that exposes no descriptor at all", async () => {
    const ws = seedWorkspace();
    const handle = await serveFileKernelOverStdio({
      workspaceRoot: ws,
      input: new PassThrough(),
      output: new PassThrough(),
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    });
    await handle.close();
  });
});

describe("serveFileKernelOverStdio", () => {
  afterEach(() => {
    if (originalAgentToolsEnv === undefined) delete process.env.CLARVIS_AGENT_TOOLS_ENABLED;
    else process.env.CLARVIS_AGENT_TOOLS_ENABLED = originalAgentToolsEnv;
  });

  it("serves a real file kernel over a stream pair and answers requests", async () => {
    const ws = seedWorkspace();
    const toServer = new PassThrough();
    const toClient = new PassThrough();

    const handle = await serveFileKernelOverStdio({
      workspaceRoot: ws,
      env: loadEnv({ CLARVIS_LOG_LEVEL: "silent" }),
      traceDir: join(ws, "traces"),
      globalDir: join(ws, "global"),
      input: toServer,
      output: toClient,
    });

    const client = await connectOverServe(toServer, toClient);

    expect(client.capabilities.agent_tools).toBe(true);

    // Seeded on disk, so withheld until approved — and approving it here also
    // exercises the trust operations over the wire rather than only in-process.
    // The shipped fleet travels the wire either way; what approval changes is
    // whether the repository's file overlays one of it.
    expect((await client.listAgents()).find((a) => a.name === "coder")?.scope).toBe("builtin");
    await client.config.approveWorkspace();
    expect((await client.listAgents()).find((a) => a.name === "coder")?.scope).toBe("workspace");

    await client.close();
    await handle.close();
  });

  it("advertises agent_tools:false when CLARVIS_AGENT_TOOLS_ENABLED=false", async () => {
    process.env.CLARVIS_AGENT_TOOLS_ENABLED = "false";

    const ws = seedWorkspace();
    const toServer = new PassThrough();
    const toClient = new PassThrough();

    const handle = await serveFileKernelOverStdio({
      workspaceRoot: ws,
      env: loadEnv({ CLARVIS_LOG_LEVEL: "silent" }),
      traceDir: join(ws, "traces"),
      globalDir: join(ws, "global"),
      input: toServer,
      output: toClient,
    });

    const client = await connectOverServe(toServer, toClient);

    expect(client.capabilities.agent_tools).toBe(false);

    await client.close();
    await handle.close();
  });

  it("close() tears the connection down without ending the underlying streams", async () => {
    const ws = seedWorkspace();
    const toServer = new PassThrough();
    const toClient = new PassThrough();

    const handle = await serveFileKernelOverStdio({
      workspaceRoot: ws,
      env: loadEnv({ CLARVIS_LOG_LEVEL: "silent" }),
      traceDir: join(ws, "traces"),
      globalDir: join(ws, "global"),
      input: toServer,
      output: toClient,
    });

    await handle.close();

    expect(toServer.writable).toBe(true);
    expect(toClient.writable).toBe(true);
  });

  it("close() is safe to call more than once", async () => {
    const ws = seedWorkspace();
    const toServer = new PassThrough();
    const toClient = new PassThrough();

    const handle = await serveFileKernelOverStdio({
      workspaceRoot: ws,
      env: loadEnv({ CLARVIS_LOG_LEVEL: "silent" }),
      traceDir: join(ws, "traces"),
      globalDir: join(ws, "global"),
      input: toServer,
      output: toClient,
    });

    await handle.close();
    await expect(handle.close()).resolves.toBeUndefined();
  });
});
