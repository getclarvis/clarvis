import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cacheHash } from "../../cache/wire.ts";
import { globalPaths } from "@clarvis/paths";
import { prepareHostAuthView, supportsHostAuthView } from "../../cache/host-auth-view.ts";

test.skipIf(!supportsHostAuthView)(
  "global OAuth stays authoritative while installed-host state is isolated",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "cache-auth-view-"));
    const authenticationRoot = join(root, "authentication");
    const isolatedRoot = join(root, "isolated");
    await mkdir(authenticationRoot);
    await mkdir(isolatedRoot);
    await writeFile(
      globalPaths(authenticationRoot).subscriptionsFile,
      JSON.stringify({
        version: 1,
        accounts: {
          "openai-codex": { access_token: "synthetic", refresh_token: "original", expires_at: 1 },
        },
      }),
    );
    await writeFile(globalPaths(authenticationRoot).settingsFile, "original configuration");
    await mkdir(globalPaths(isolatedRoot).state);
    await writeFile(globalPaths(isolatedRoot).settingsFile, "isolated configuration");
    const view = await prepareHostAuthView({
      authenticationRoot,
      isolatedRoot,
      mountedRoot: join(root, "view"),
    });
    try {
      const script = join(root, "probe.ts");
      await writeFile(
        script,
        `import {createFileSubscriptionStore} from ${JSON.stringify(resolve("packages/kernel/src/subscriptions/store.ts"))}; import {writeFile,readFile} from "node:fs/promises"; const dir=process.argv[2]; if(await readFile(dir+"/settings.json","utf8")!=="isolated configuration")throw new Error("wrong configuration");await writeFile(dir+"/state/probe","isolated state");const store=createFileSubscriptionStore({dir});await store.mutateAccount("openai-codex", account=>({account:{...account,refresh_token:"renewed"},result:undefined}));`,
      );
      const child = Bun.spawn([...view.command, process.execPath, script, view.globalDir], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, errors] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(errors).toBe("");
      expect(code).toBe(0);
      expect(
        JSON.parse(await readFile(globalPaths(authenticationRoot).subscriptionsFile, "utf8"))
          .accounts["openai-codex"].refresh_token,
      ).toBe("renewed");
      expect(await readFile(join(globalPaths(isolatedRoot).state, "probe"), "utf8")).toBe(
        "isolated state",
      );
      expect(await readFile(globalPaths(authenticationRoot).settingsFile, "utf8")).toBe(
        "original configuration",
      );
      expect(await Bun.file(globalPaths(isolatedRoot).subscriptionsFile).exists()).toBe(false);
    } finally {
      await view.cleanup();
      await rm(root, { recursive: true, force: true });
    }
  },
);

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
        env: { ...process.env, CLARVIS_CACHE_ARTIFACT_OBSERVER: config },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [status, errors] = await Promise.all([child.exited, new Response(child.stderr).text()]);
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
