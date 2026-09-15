#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  packCiBuild,
  readBuildIdentity,
  requireBuildProducer,
  restoreCiBuild,
} from "../lib/ci-artifacts.ts";

function record(event: string, fields: Record<string, string | number>): void {
  console.log(JSON.stringify({ event: `ci.artifacts.${event}`, ...fields }));
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `- Build ${event}: ${Object.entries(fields)
        .map(([key, value]) => `${key}=${value}`)
        .join(", ")}\n`,
    );
  }
}

function append(
  variable: "GITHUB_OUTPUT" | "GITHUB_ENV",
  name: string,
  value: string | number,
): void {
  if (!process.env[variable]) throw new Error(`${variable} is required in the CI artifact CLI`);
  appendFileSync(process.env[variable], `${name}=${value}\n`);
}

function elapsed(variable: string): number {
  const started = Number(process.env[variable]);
  const duration = Date.now() - started;
  if (!Number.isSafeInteger(started) || started <= 0 || duration < 0)
    throw new Error(`Missing or invalid transfer clock: ${variable}`);
  return duration;
}

/** Bind producer outputs to the current checkout, with transfer timings inclusive of step overhead. */
async function main(): Promise<void> {
  const root = resolve(import.meta.dir, "../..");
  const mode = process.argv[2];
  if (process.argv.length !== 3 || !["pack", "uploaded", "producer", "restore"].includes(mode)) {
    throw new Error("Usage: bun run tooling/checks/ci-artifacts.ts pack|uploaded|producer|restore");
  }
  const start = Date.now();
  if (mode === "pack") {
    const identity = await readBuildIdentity(
      root,
      process.env.GITHUB_RUN_ID,
      process.env.GITHUB_RUN_ATTEMPT,
    );
    const artifact = await packCiBuild(root, identity);
    record("pack", {
      bytes: artifact.bytes,
      duration_ms: Date.now() - start,
      commit: identity.commit,
      producer_attempt: identity.producerAttempt,
    });
    append("GITHUB_OUTPUT", "tar-digest", artifact.digest);
    append("GITHUB_OUTPUT", "producer-attempt", identity.producerAttempt);
    append("GITHUB_ENV", "CI_UPLOAD_STARTED_MS", Date.now());
    return;
  }
  const producer = requireBuildProducer(process.env);
  if (mode === "uploaded") {
    record("upload", {
      duration_ms: elapsed("CI_UPLOAD_STARTED_MS"),
      artifact_id: producer.artifactId,
      artifact_digest: producer.artifactDigest,
    });
    return;
  }
  const consumerAttempt = process.env.GITHUB_RUN_ATTEMPT;
  if (
    !/^[1-9]\d*$/.test(consumerAttempt ?? "") ||
    Number(producer.attempt) > Number(consumerAttempt)
  )
    throw new Error("Invalid consumer attempt or future build producer");
  const identity = await readBuildIdentity(root, process.env.GITHUB_RUN_ID, producer.attempt);
  if (mode === "producer") {
    record("producer", {
      artifact_id: producer.artifactId,
      producer_attempt: producer.attempt,
      consumer_attempt: consumerAttempt,
      commit: identity.commit,
    });
    append("GITHUB_ENV", "CI_DOWNLOAD_STARTED_MS", Date.now());
    return;
  }
  record("download", {
    duration_ms: elapsed("CI_DOWNLOAD_STARTED_MS"),
    artifact_id: producer.artifactId,
  });
  const restoreStarted = Date.now();
  const bytes = await restoreCiBuild(
    root,
    join(root, "coverage/ci/incoming/linux-build.tar"),
    identity,
    producer.tarDigest,
  );
  record("restore", {
    bytes,
    duration_ms: Date.now() - restoreStarted,
    producer_attempt: producer.attempt,
    consumer_attempt: consumerAttempt,
  });
}

if (import.meta.main) await main();
