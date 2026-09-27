#!/usr/bin/env bun
import { executeCoverageCommand } from "../lib/ci-coverage.ts";
import { runTestTemporaryAudit, type TemporaryAuditEvent } from "../lib/test-temporary-audit.ts";

/** Audit one argv through the same process owner used by CI coverage. */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "--") argv.shift();
  if (argv.length === 0) throw new Error("Usage: bun run test:cleanup -- <command> [args...]");
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  const emit = (event: TemporaryAuditEvent) =>
    console.log(JSON.stringify({ event: "test.temporary_audit", ...event }));
  try {
    const result = await runTestTemporaryAudit(
      { argv, cwd: process.cwd(), env: process.env, signal: controller.signal },
      argv.join(" "),
      { execute: executeCoverageCommand, emit },
    );
    process.exitCode = result.code;
  } catch (error) {
    console.error(error);
    process.exitCode = controller.signal.aborted ? 130 : 1;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}

if (import.meta.main) await main();
