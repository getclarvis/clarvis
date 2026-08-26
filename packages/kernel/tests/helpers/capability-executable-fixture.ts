import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

interface RequestMessage {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

let delayed: RequestMessage | undefined;

function respond(id: number, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

async function handle(request: RequestMessage): Promise<void> {
  const params = request.params ?? {};
  switch (request.method) {
    case "initialize": {
      switch (process.env.INIT_MODE) {
        case "null":
          respond(request.id, null);
          return;
        case "version":
          respond(request.id, { protocol_version: 2, provider_kind: "fixture" });
          return;
        case "kind":
          respond(request.id, { protocol_version: 1, provider_kind: "" });
          return;
        case "writable":
          respond(request.id, {
            protocol_version: 1,
            provider_kind: "fixture",
            writable: "yes",
          });
          return;
        case "missing-writable":
          respond(request.id, { protocol_version: 1, provider_kind: "fixture" });
          return;
        default:
          respond(request.id, {
            protocol_version: 1,
            provider_kind: "fixture",
            writable: true,
          });
          return;
      }
    }
    case "shutdown":
      if (process.env.SHUTDOWN_MARKER !== undefined) {
        writeFileSync(process.env.SHUTDOWN_MARKER, "shutdown\n", "utf8");
      }
      respond(request.id, null);
      return;
    case "test/inspect":
      respond(request.id, {
        pid: process.pid,
        cwd: process.cwd(),
        argv: process.argv.slice(2),
        inherited: process.env.INHERITED,
        expanded: process.env.EXPANDED,
      });
      return;
    case "test/slow":
      delayed = request;
      return;
    case "test/fast":
      respond(request.id, "fast");
      if (delayed !== undefined) {
        respond(delayed.id, "slow");
        delayed = undefined;
      }
      return;
    case "test/hang":
      return;
    case "test/malformed":
      process.stdout.write("not-json\n");
      return;
    case "test/non-object":
      process.stdout.write("[]\n");
      return;
    case "test/invalid-response":
      process.stdout.write(`${JSON.stringify({ jsonrpc: "1.0", id: request.id, result: null })}\n`);
      return;
    case "test/unknown-id":
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: request.id + 100, result: null })}\n`,
      );
      return;
    case "test/result-and-error":
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: null,
          error: { code: 1, message: "bad" },
        })}\n`,
      );
      return;
    case "test/oversized-line":
      process.stdout.write(`${"x".repeat(1024 * 1024 + 1)}\n`);
      return;
    case "test/stderr-die":
      await Bun.write(Bun.stderr, "fixture diagnostic\n");
      return process.exit(19);
    case "test/oversized":
      process.stdout.write("x".repeat(1024 * 1024 + 1));
      return;
    case "test/die":
      return process.exit(17);
    case "test/rpc-error":
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32_001,
            message: "fixture conflict",
            data: { code: "plan_conflict" },
          },
        })}\n`,
      );
      return;
    case "test/rpc-error-invalid":
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: "bad" })}\n`);
      return;
    case "test/mutate-die":
      appendFileSync(String(params.path), "mutation\n", "utf8");
      return process.exit(18);
    case "test/read-count": {
      let content = "";
      try {
        content = readFileSync(String(params.path), "utf8").trim();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      respond(request.id, content === "" ? 0 : content.split(/\r?\n/).length);
      return;
    }
    default:
      respond(request.id, params);
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) await handle(JSON.parse(line) as RequestMessage);
