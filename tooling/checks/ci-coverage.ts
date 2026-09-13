#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { executeCoverageCommand, runCiCoverage, type CoverageEvent } from "../lib/ci-coverage.ts";

/** Own CLI signals and the Actions annotations; no product code or coverage policy lives here. */
async function main(): Promise<void> {
  if (process.argv.length !== 2) throw new Error("Usage: bun run tooling/checks/ci-coverage.ts");
  const controller = new AbortController();
  let cancelledExit = 143;
  const interrupt = () => {
    cancelledExit = 130;
    controller.abort();
  };
  const terminate = () => {
    cancelledExit = 143;
    controller.abort();
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  const summary = (text: string) => {
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
  };
  const emit = (event: CoverageEvent) => {
    console.log(JSON.stringify({ event: "ci.coverage", ...event }));
    if (event.phase === "retry") {
      const note = `Bun crash (exit ${event.result.code}): @clarvis/code retry ${event.attempt - 1}/3`;
      console.warn(`::warning::${note}`);
      summary(`- ${note}`);
    }
    if (event.phase === "end")
      summary(
        `- ${event.package}, attempt ${event.attempt}: exit ${event.result.code}, ${event.durationMs} ms`,
      );
  };
  try {
    const result = await runCiCoverage(resolve(import.meta.dir, "../.."), {
      execute: executeCoverageCommand,
      now: Date.now,
      signal: controller.signal,
      env: process.env,
      emit,
      bun: process.execPath,
    });
    process.exitCode = result.code;
    summary(`Coverage supervisor: ${result.code === 0 ? "success" : `failure (${result.code})`}.`);
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    process.exitCode = cancelledExit;
    summary(`Coverage supervisor: cancelled (${cancelledExit}); active child settled.`);
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}

if (import.meta.main) await main();
