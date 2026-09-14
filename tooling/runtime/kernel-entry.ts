#!/usr/bin/env bun
import { Ajv } from "ajv";
import * as formatsModule from "ajv-formats";
import { sanitizeErrorMessage } from "@clarvis/capability";
import { serveContainerKernel } from "@clarvis/kernel/bootstrap";
import { installBundledAjvModules } from "../../packages/loop/src/validation/ajv.ts";

installBundledAjvModules({ Ajv, addFormats: formatsModule.default.default });

try {
  const host = serveContainerKernel();
  const stop = (): void => {
    void host.close().catch(() => undefined);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await host.closed;
} catch (error) {
  process.stderr.write(
    `${sanitizeErrorMessage(error instanceof Error ? error.message : String(error))}\n`,
  );
  process.exitCode = 1;
}
