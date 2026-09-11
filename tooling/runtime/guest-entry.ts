import { Ajv } from "ajv";
import * as formatsModule from "ajv-formats";
import { startGuestMain } from "../../packages/kernel/src/runtime/guest-main.ts";
import { runGuestPreviewCommand } from "../../packages/kernel/src/runtime/preview-relay.ts";
import { installBundledAjvModules } from "../../packages/loop/src/validation/ajv.ts";

/** Enter the guest worker after installing its statically bundled validator modules. */
export async function runGuestEntry(): Promise<void> {
  const previewExit = await runGuestPreviewCommand(
    process.argv.slice(2),
    process.stdin,
    process.stdout,
  );
  if (previewExit !== null) {
    process.exitCode = previewExit;
    return;
  }
  installBundledAjvModules({ Ajv, addFormats: formatsModule.default.default });
  const worker = startGuestMain({
    environment: process.env,
    input: process.stdin,
    output: process.stdout,
  });
  if (worker === null) process.exitCode = 64;
}

if (import.meta.main) void runGuestEntry().catch(() => (process.exitCode = 1));
