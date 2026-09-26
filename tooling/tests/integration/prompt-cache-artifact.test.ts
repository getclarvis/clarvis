import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cacheHash } from "../../cache/wire.ts";

test("artifact observer hashes the JavaScript bytes actually loaded and captures physical HTTP without credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "cache-loaded-bundle-"));
  try {
    const bundleDirectory = join(root, "dist");
    await mkdir(bundleDirectory);
    const bundle = 'globalThis.fixtureLoaded = "exact bundle bytes";';
    await writeFile(join(bundleDirectory, "index.js"), bundle);
    const evidence = join(root, "evidence.jsonl");
    const config = join(root, "config.json");
    await writeFile(
      config,
      JSON.stringify({
        bundleDirectory,
        evidence,
        model: "gpt-6-astra",
        trial: 1,
        leaderId: "agent",
        sdkVersion: "fixture",
        limits: { calls: 4, input: 100000, output: 1000, durationMs: 10000 },
      }),
    );
    await writeFile(
      join(root, "transport.ts"),
      'globalThis.fetch = Object.assign(async () => Response.json({status:"completed", usage:{input_tokens:20000,output_tokens:20,input_tokens_details:{cached_tokens:19000}}}), {preconnect(){}});',
    );
    await writeFile(
      join(root, "entry.ts"),
      `await import("./dist/index.js"); if (globalThis.fixtureLoaded !== "exact bundle bytes") throw new Error("bundle not loaded"); const response = await fetch("https://chatgpt.com/backend-api/codex/responses", {body:JSON.stringify({model:"gpt-6-astra",prompt_cache_key:"session_agent",input:[{role:"user",content:"fixture"}]}),headers:{authorization:"private-fixture"}}); await response.text(); await Bun.sleep(50);`,
    );
    const child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        join(root, "transport.ts"),
        "--preload",
        resolve("tooling/cache/artifact-preload.ts"),
        join(root, "entry.ts"),
      ],
      {
        env: {
          PATH: process.env.PATH ?? "",
          HOME: join(root, "home"),
          CLARVIS_HOME: join(root, "global"),
          CLARVIS_CACHE_ARTIFACT_OBSERVER: config,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [status, output, errors] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(output).toBe("");
    expect(errors).toBe("");
    expect(status).toBe(0);
    const text = await readFile(evidence, "utf8");
    const records = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records.find((record) => record.type === "loaded_bundle")).toMatchObject({
      path: "index.js",
      hash: cacheHash(bundle),
    });
    expect(records.find((record) => record.type === "physical_call").call).toMatchObject({
      purpose: "leader",
      usage: { input: 20000, cached: 19000, output: 20 },
    });
    expect(text).not.toContain("private-fixture");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
