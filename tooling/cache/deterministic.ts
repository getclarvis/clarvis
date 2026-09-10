import { resolve } from "node:path";

/** Credential-free real-SDK contract gate, preserving each workspace's supported preload. */
export async function testPromptCacheContracts(): Promise<void> {
  const suites: Array<[string, string[]]> = [
    ["capability", ["unit/prompt-cache-identity.test.ts"]],
    [
      "llm",
      [
        "integration/provider-request-shape.test.ts",
        "integration/wire-cache-diff.test.ts",
        "unit/prompt-cache-provider.test.ts",
        "unit/request-prefix.test.ts",
      ],
    ],
    [
      "loop",
      [
        "integration/cache-prefix-capture.test.ts",
        "integration/prompt-cache-breakpoints.test.ts",
        "integration/openai-compatible-run.test.ts",
        "unit/context-snapshot.test.ts",
        "unit/entry-seed-markers.test.ts",
        "unit/prefix-break.test.ts",
        "unit/context-compaction.test.ts",
      ],
    ],
    ["plan", ["component/plan-orchestration.test.ts", "unit/plan-canonical-state.test.ts"]],
    [
      "memory",
      [
        "unit/indexer-continuation.test.ts",
        "integration/job-durability.test.ts",
        "integration/continuation-elicitation.test.ts",
        "component/continuation-sanitized-trace.test.ts",
      ],
    ],
    ["kernel", ["integration/prompt-cache-composition.test.ts"]],
    ["code", ["component/kernel-run-client.test.ts"]],
  ];
  for (const [workspace, files] of suites) {
    const child = Bun.spawn(
      [process.execPath, "test", ...files.map((file) => `tests/${file}`), "--timeout", "60000"],
      {
        cwd: resolve("packages", workspace),
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    if ((await child.exited) !== 0) throw new Error(`Prompt-cache contract failed in ${workspace}`);
  }
  const evaluator = Bun.spawn(
    [
      process.execPath,
      "test",
      "tooling/tests/unit/prompt-cache-evaluation.test.ts",
      "tooling/tests/unit/prompt-cache-recorder.test.ts",
      "tooling/tests/unit/prompt-cache-artifact.test.ts",
      "--timeout",
      "60000",
    ],
    { stdin: "ignore", stdout: "inherit", stderr: "inherit" },
  );
  if ((await evaluator.exited) !== 0) throw new Error("Prompt-cache evidence evaluation failed");
}

if (import.meta.main) await testPromptCacheContracts();
