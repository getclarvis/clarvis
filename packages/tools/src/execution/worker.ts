import { createInterface } from "node:readline";
import { workspaceStatePathsFromRoot } from "@clarvis/paths";
import { Ajv } from "ajv";
import { resolveConfig, type RuntimeConfig } from "../config.ts";
import { ToolError } from "../errors.ts";
import { getTool, selectSurface } from "../tools/registry.ts";
import type { ToolResult } from "../tools/content.ts";
import {
  MAX_WORKER_FRAME_BYTES,
  WORKER_PROTOCOL_VERSION,
  type WorkerCall,
  type WorkerConfigDto,
  type WorkerResult,
} from "./worker-protocol.ts";

const ajv = new Ajv({ allErrors: true, useDefaults: true, coerceTypes: true });
const writer = Bun.stdout.writer();
let config: RuntimeConfig | undefined;

function failProtocol(): void {
  process.exitCode = 64;
  process.stdin.destroy();
}

async function send(frame: WorkerResult): Promise<void> {
  const encoded = JSON.stringify(frame);
  if (Buffer.byteLength(encoded, "utf8") > MAX_WORKER_FRAME_BYTES) {
    throw new Error("worker result exceeds protocol limit");
  }
  await writer.write(`${encoded}\n`);
  await writer.flush();
}

function resolvedConfig(dto: WorkerConfigDto): RuntimeConfig {
  return resolveConfig({
    ...dto,
    statePaths: workspaceStatePathsFromRoot(dto.workspaceRoot, dto.stateRoot),
  });
}

async function handle(call: WorkerCall): Promise<void> {
  if (config === undefined || call.version !== WORKER_PROTOCOL_VERSION || call.type !== "call") {
    throw new Error("worker protocol mismatch");
  }
  const id = call.id;
  const tool = getTool(call.name, selectSurface(config.readOnly));
  if (
    !Number.isSafeInteger(id) ||
    !tool ||
    tool.name === "shell" ||
    tool.name === "shell_session"
  ) {
    await send({
      version: WORKER_PROTOCOL_VERSION,
      type: "result",
      id,
      error: { code: "invalid_input", message: "Invalid worker operation" },
    });
    return;
  }
  const validate = ajv.compile(tool.inputSchema);
  const args = structuredClone(call.args);
  if (!validate(args)) {
    await send({
      version: WORKER_PROTOCOL_VERSION,
      type: "result",
      id,
      error: { code: "invalid_input", message: ajv.errorsText(validate.errors) },
    });
    return;
  }
  try {
    const result: string | ToolResult = await tool.handler(args, config);
    await send({ version: WORKER_PROTOCOL_VERSION, type: "result", id, result });
  } catch (error) {
    const toolError =
      error instanceof ToolError ? error : new ToolError("internal", "internal error");
    await send({
      version: WORKER_PROTOCOL_VERSION,
      type: "result",
      id,
      error: { code: toolError.code, message: toolError.message, fields: toolError.fields },
    });
  }
}

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (Buffer.byteLength(line, "utf8") > MAX_WORKER_FRAME_BYTES) {
    failProtocol();
    break;
  }
  let frame: unknown;
  try {
    frame = JSON.parse(line);
  } catch {
    failProtocol();
    break;
  }
  if (config === undefined) {
    if (
      typeof frame !== "object" ||
      frame === null ||
      !("type" in frame) ||
      frame.type !== "init" ||
      !("version" in frame) ||
      frame.version !== WORKER_PROTOCOL_VERSION ||
      !("config" in frame)
    ) {
      failProtocol();
      break;
    }
    try {
      config = resolvedConfig(frame.config as WorkerConfigDto);
      await send({ version: WORKER_PROTOCOL_VERSION, type: "ready" });
    } catch {
      failProtocol();
      break;
    }
    continue;
  }
  try {
    await handle(frame as WorkerCall);
  } catch {
    failProtocol();
    break;
  }
}
